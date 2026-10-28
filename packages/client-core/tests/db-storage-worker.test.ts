import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  createLocalDBStorage,
  createWorkerDBStorage,
  DBStorageClosedError,
  LeaderChangedError,
  startDBStorageWorker,
  TransactionStatementError,
  type DBEngine,
  type DBStorage,
} from "../src/db-storage";
import { deserializeError, isRetriableError, serializeError } from "../src/db-storage/errors";
import { createDisk, memoryEngine, q } from "./helpers/db-storage";
import { settle } from "./helpers/storage";
import { FakeBroadcastChannel, installTabs, type FakeLockManager } from "./helpers/tabs";

const ports: MessagePort[] = [];

afterEach(() => {
  for (const port of ports.splice(0)) port.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A storage whose "worker" is the other end of a MessageChannel in this process. */
function workerStorage(
  locks: FakeLockManager,
  tag: string,
  open: (options: unknown) => DBEngine | Promise<DBEngine>,
  extra: { engineOptions?: unknown; transactionTimeoutMs?: number } = {},
) {
  class TabChannel extends FakeBroadcastChannel {
    constructor(name: string) {
      super(name);
      this.tag = tag;
    }
  }
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  const scope = Object.assign(port2, { navigator: { locks }, BroadcastChannel: TabChannel });
  startDBStorageWorker((options) => open(options), scope as never);
  const terminate = vi.fn();
  const storage = createWorkerDBStorage({
    dialect: "sqlite",
    worker: () => Object.assign(port1, { terminate }) as never,
    ...extra,
  });
  return { storage, terminate };
}

const rowsOf = async (storage: DBStorage) => (await storage.exec(q("GET", "all"))).rows;

test("worker storages elect a leader, forward queries and run transactions", async () => {
  const { locks } = installTabs();
  const disk = createDisk();
  const engineOptions = vi.fn();
  const a = workerStorage(
    locks,
    "a",
    (options) => {
      engineOptions(options);
      return memoryEngine(disk);
    },
    { engineOptions: { file: "todo.db" } },
  );
  await a.storage.ready;
  const b = workerStorage(locks, "b", () => memoryEngine(disk));
  await b.storage.ready;
  expect([a.storage.role, b.storage.role]).toEqual(["leader", "follower"]);
  expect(a.storage.dialect).toBe("sqlite");
  expect(a.storage.key).toBe("default");
  expect(engineOptions).toHaveBeenCalledWith({ file: "todo.db" });

  await b.storage.exec(q("SET a 1"));
  expect(
    await b.storage.transaction(async (tx) => {
      await tx.exec(q("SET b 1"));
      return (await tx.exec(q("GET", "all"))).rows.length;
    }),
  ).toBe(2);
  await expect(
    b.storage.transaction(async (tx) => {
      await tx.exec(q("SET rolled 1"));
      throw new Error("abort");
    }),
  ).rejects.toThrow("abort");
  expect(await rowsOf(a.storage)).toEqual([
    ["a", "1"],
    ["b", "1"],
  ]);
  // Errors keep their class across the worker boundary.
  await expect(b.storage.exec(q("BEGIN"))).rejects.toBeInstanceOf(TransactionStatementError);
  await expect(b.storage.exec(q("BOOM"))).rejects.toThrow("statement failed: BOOM");

  await Promise.all([a.storage.close(), b.storage.close()]);
  expect(a.terminate).toHaveBeenCalledOnce();
});

test("a commit that fails surfaces from transaction()", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { locks } = installTabs();
    const { storage } = workerStorage(locks, "a", () => memoryEngine(), {
      transactionTimeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(0);
    await storage.ready;
    const result = storage.transaction(async (tx) => {
      await tx.exec(q("SET a 1"));
      // Idle past the transaction timeout: the leader rolls it back.
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const assertion = expect(result).rejects.toThrow("no longer open");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    await storage.close();
  } finally {
    vi.useRealTimers();
  }
});

test("page lifecycle hands leadership over and back, with role and invalidate events", async () => {
  const { locks } = installTabs();
  const listeners: Array<Map<string, (event: { persisted?: boolean }) => void>> = [];
  let current = new Map<string, (event: { persisted?: boolean }) => void>();
  vi.stubGlobal("addEventListener", (type: string, listener: any) => current.set(type, listener));
  vi.stubGlobal("removeEventListener", (type: string, listener: unknown) => {
    for (const map of listeners) if (map.get(type) === listener) map.delete(type);
  });
  const disk = createDisk();
  listeners.push(current);
  const a = workerStorage(locks, "a", () => memoryEngine(disk));
  await a.storage.ready;
  current = new Map();
  listeners.push(current);
  const b = workerStorage(locks, "b", () => memoryEngine(disk));
  await b.storage.ready;
  const roles = vi.fn();
  const invalidated = vi.fn();
  const unsubscribeRole = b.storage.onRoleChange(roles);
  const unsubscribeInvalidate = b.storage.onInvalidate(invalidated);

  listeners[0]!.get("pagehide")!({});
  await settle(8);
  expect(b.storage.role).toBe("leader");
  expect(roles).toHaveBeenCalledWith("leader");
  expect(a.storage.role).toBe("follower");

  listeners[0]!.get("pageshow")!({ persisted: false });
  listeners[0]!.get("pageshow")!({ persisted: true });
  await settle(8);
  expect(a.storage.role).toBe("follower");
  listeners[1]!.get("pagehide")!({});
  await settle(8);
  expect(a.storage.role).toBe("leader");
  expect(invalidated).toHaveBeenCalled();
  unsubscribeRole();
  unsubscribeInvalidate();

  await a.storage.close();
  expect(listeners[0]!.size).toBe(0);
  await expect(a.storage.exec(q("GET", "all"))).rejects.toBeInstanceOf(DBStorageClosedError);
  await a.storage.close();
  await b.storage.close();
});

test("an engine that cannot open rejects readiness and reports through onError", async () => {
  const { locks } = installTabs();
  const failure = vi.fn();
  const { storage } = workerStorage(locks, "a", () => {
    throw new Error("quota exceeded");
  });
  storage.onError(failure);
  const unsubscribe = storage.onError(() => {});
  unsubscribe();
  await expect(storage.ready).rejects.toThrow("quota exceeded");
  expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: "quota exceeded" }));
  await storage.close();
});

test("closing rejects requests still waiting for a leader", async () => {
  const { locks } = installTabs();
  const { storage } = workerStorage(locks, "a", () => new Promise<DBEngine>(() => {}));
  const pending = storage.exec(q("GET", "all"));
  const assertion = expect(pending).rejects.toBeInstanceOf(DBStorageClosedError);
  await settle();
  await storage.close();
  await assertion;
  await expect(storage.ready).rejects.toBeInstanceOf(DBStorageClosedError);
});

test("the worker runtime rejects requests before init and ignores unknown messages", async () => {
  const posted: any[] = [];
  const scope = { postMessage: (message: unknown) => posted.push(message), onmessage: null as any };
  startDBStorageWorker(() => memoryEngine(), scope as never);
  const send = (data: unknown) => scope.onmessage({ data } as MessageEvent);
  send({ t: "request", id: 1, body: { t: "exec", query: q("GET", "all") } });
  send({ t: "release" });
  send({ t: "rejoin" });
  send({ t: "unknown" });
  send(undefined);
  send({ t: "close", id: 2 });
  await settle();
  expect(posted).toEqual([
    expect.objectContaining({ t: "response", id: 1, ok: false }),
    { t: "response", id: 2, ok: true },
  ]);

  // Without Web Locks in the worker, the storage reports it; a second init is ignored.
  send({ t: "init", key: "k", clientId: "c", engineOptions: undefined });
  send({ t: "init", key: "k", clientId: "c", engineOptions: undefined });
  expect(posted.at(-1)).toMatchObject({
    t: "error",
    error: { name: "CoordinationUnavailableError" },
  });
});

test("the main-thread storage ignores unknown and stale worker messages", async () => {
  const endpoint = { postMessage: vi.fn(), onmessage: null as any };
  const storage = createWorkerDBStorage({ dialect: "postgres", key: "pg", worker: () => endpoint });
  expect(endpoint.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ t: "init", key: "pg" }),
  );
  endpoint.onmessage({ data: { t: "response", id: 99, ok: true } });
  endpoint.onmessage({ data: { t: "unknown" } });
  endpoint.onmessage({ data: undefined });
  const lastRequest = () => endpoint.postMessage.mock.calls.at(-1)![0];
  const respond = (data: Record<string, unknown>) =>
    endpoint.onmessage({ data: { t: "response", id: lastRequest().id, ...data } });

  // The application error wins over a rollback that fails too.
  const failed = storage.transaction(async () => {
    throw new Error("app failure");
  });
  respond({ ok: true, result: "epoch/tx-1" });
  await settle();
  expect(lastRequest().body).toEqual({ t: "rollback", txId: "epoch/tx-1" });
  respond({ ok: false, error: { name: "Error", message: "rollback failed" } });
  await expect(failed).rejects.toThrow("app failure");

  // Requests the worker never answered are rejected on close.
  const unanswered = storage.exec(q("GET", "all"));
  const assertion = expect(unanswered).rejects.toBeInstanceOf(DBStorageClosedError);
  const closing = storage.close();
  const closeId = endpoint.postMessage.mock.calls.at(-1)![0].id;
  endpoint.onmessage({ data: { t: "response", id: closeId, ok: true } });
  await closing;
  await assertion;
});

test("errors survive serialization, including foreign ones", () => {
  const restored = deserializeError(serializeError(new LeaderChangedError("moved")));
  expect(restored).toBeInstanceOf(LeaderChangedError);
  expect(restored.message).toBe("moved");
  expect(isRetriableError(restored)).toBe(true);
  const custom = new TypeError("bad");
  expect(deserializeError(serializeError(custom))).toMatchObject({
    name: "TypeError",
    message: "bad",
  });
  expect(serializeError("plain")).toEqual({ name: "Error", message: "plain" });
  expect(isRetriableError(undefined)).toBe(false);
});

test("local storage leads in-process and runs transactions", async () => {
  const engine = memoryEngine();
  const storage = createLocalDBStorage({ dialect: "sqlite", open: () => engine });
  await storage.ready;
  expect(storage.role).toBe("leader");
  expect(storage.key).toBe("default");
  storage.onRoleChange(() => {})();
  storage.onInvalidate(() => {})();
  storage.onError(() => {})();
  await storage.exec(q("SET a 1"));
  expect(await storage.transaction(async (tx) => (await tx.exec(q("GET", "all"))).rows)).toEqual([
    ["a", "1"],
  ]);
  await expect(
    storage.transaction(async (tx) => {
      await tx.exec(q("SET b 1"));
      throw new Error("abort");
    }),
  ).rejects.toThrow("abort");
  expect(engine.disk.rows.has("b")).toBe(false);
  // A failing rollback does not hide the application error.
  const exec = engine.exec.getMockImplementation()!;
  engine.exec.mockImplementation(async (query) => {
    const result = await exec(query);
    if (query.sql === "ROLLBACK") throw new Error("rollback failed");
    return result;
  });
  await expect(
    storage.transaction(async () => {
      throw new Error("app failure");
    }),
  ).rejects.toThrow("app failure");
  engine.exec.mockImplementation(exec);
  await storage.close();
  await storage.close();
  expect(engine.close).toHaveBeenCalledOnce();
  await expect(storage.exec(q("GET", "all"))).rejects.toBeInstanceOf(DBStorageClosedError);

  const broken = createLocalDBStorage({
    dialect: "postgres",
    key: "pg",
    open: async () => Promise.reject(new Error("no wasm")),
  });
  await expect(broken.ready).rejects.toThrow("no wasm");
  await broken.close();
});

test("local storage: statements outside a transaction neither see nor join it", async () => {
  const engine = memoryEngine();
  const storage = createLocalDBStorage({ dialect: "sqlite", open: () => engine });
  let releaseTx!: () => void;
  const txOpen = new Promise<void>((resolve) => (releaseTx = resolve));
  let readRows: unknown[] | undefined;
  let read: Promise<unknown> | undefined;
  const committed = storage.transaction(async (tx) => {
    await tx.exec(q("SET uncommitted 1"));
    // Same context, outside the transaction handle: waits for the commit.
    read = storage.exec(q("GET", "all")).then((result) => (readRows = result.rows));
    await txOpen;
  });
  await vi.waitFor(() => expect(read).toBeDefined());
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(readRows).toBeUndefined();
  releaseTx();
  await committed;
  await read;
  expect(readRows).toEqual([["uncommitted", "1"]]);

  let write: Promise<unknown> | undefined;
  await expect(
    storage.transaction(async (tx) => {
      await tx.exec(q("SET rolledBack 1"));
      write = storage.exec(q("SET outside 1"));
      throw new Error("abort");
    }),
  ).rejects.toThrow("abort");
  await write;
  // The write ran on its own after the rollback, so it survived it.
  expect([...engine.disk.rows.keys()].sort()).toEqual(["outside", "uncommitted"]);
  await storage.close();
});
