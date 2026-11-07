import { afterEach, expect, test, vi } from "vite-plus/test";
import { ChangeBus } from "../src/change-bus";
import {
  CoordinationUnavailableError,
  createLocalDBStorage,
  createWorkerDBStorage,
  DBStorageClosedError,
  DBStorageDestroyedError,
  DBStorageDestroyUnsupportedError,
  startDBStorageWorker,
} from "../src/db-storage";
import { clientLockName, leaderLockName } from "../src/db-storage/protocol";
import { PendingWritesError } from "../src/sync-client";
import { SyncClientImpl } from "../src/sync-client/sync-client";
import { createDisk, memoryEngine, q, startNode } from "./helpers/db-storage";
import { clientConfig, fakeDBStorage, makeDb, settle } from "./helpers/storage";
import { FakeBroadcastChannel, installTabs, type FakeLockManager } from "./helpers/tabs";

const ports: MessagePort[] = [];

afterEach(() => {
  for (const port of ports.splice(0)) port.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const exec = (node: { request(body: unknown): Promise<unknown> }, sql: string) =>
  node.request({ t: "exec", query: q(sql, sql === "GET" ? "all" : "run") });

// --- Storage nodes (one per context) ---

test("a follower deletes the database once every other context closed and no engine is open", async () => {
  const { locks } = installTabs();
  const disk = createDisk();
  const destroy = vi.fn(async () => {
    // No context leads meanwhile: the engine is closed and nobody can reopen it.
    expect(locks.held.has(leaderLockName("default"))).toBe(true);
    expect(leader.engines[0]!.close).toHaveBeenCalledOnce();
    expect(locks.held.has(clientLockName("default", "a"))).toBe(false);
    expect(locks.held.has(clientLockName("default", "c"))).toBe(false);
    disk.rows.clear();
  });
  const leader = startNode(locks, "a", { disk, destroy });
  await settle();
  const caller = startNode(locks, "b", { disk, destroy });
  const other = startNode(locks, "c", { disk, destroy });
  await settle();
  await exec(caller.node, "SET a 1");

  const first = caller.node.destroy();
  // Concurrent calls share one delete.
  expect(caller.node.destroy()).toStrictEqual(first);
  await first;
  expect(destroy).toHaveBeenCalledOnce();
  expect(disk.rows.size).toBe(0);
  expect(leader.destroyed).toHaveBeenCalledOnce();
  expect(other.destroyed).toHaveBeenCalledOnce();
  expect(caller.destroyed).not.toHaveBeenCalled();
  // Nobody took the lead again.
  expect([...leader.engines, ...caller.engines, ...other.engines]).toHaveLength(1);

  await expect(exec(caller.node, "GET")).rejects.toBeInstanceOf(DBStorageDestroyedError);
  await expect(exec(other.node, "GET")).rejects.toBeInstanceOf(DBStorageDestroyedError);
  // Safe to call twice, in any context; closing a destroyed node does nothing.
  await caller.node.destroy();
  await other.node.destroy();
  await other.node.close();
  expect(destroy).toHaveBeenCalledOnce();
  expect(locks.held.size).toBe(0);
});

test("the leader deletes the database after stepping down", async () => {
  const { locks } = installTabs();
  const destroy = vi.fn(async () => {});
  const leader = startNode(locks, "a", { destroy });
  await settle();
  const follower = startNode(locks, "b", { destroy });
  await settle();
  // A request in flight to the leader fails as the database goes away.
  const read = exec(follower.node, "WAIT 30");
  await leader.node.destroy();
  await expect(read).rejects.toThrow();
  expect(leader.engines[0]!.close).toHaveBeenCalledOnce();
  expect(follower.destroyed).toHaveBeenCalledOnce();
  expect(destroy).toHaveBeenCalledOnce();
  expect(follower.engines).toHaveLength(0);
});

test("without a destroy function or coordination, destroy rejects and the node keeps working", async () => {
  const { locks } = installTabs();
  const plain = startNode(locks, "a");
  await settle();
  await expect(plain.node.destroy()).rejects.toBeInstanceOf(DBStorageDestroyUnsupportedError);
  await exec(plain.node, "SET a 1");
  await plain.node.close();
  await expect(plain.node.destroy()).rejects.toBeInstanceOf(DBStorageClosedError);

  const alone = startNode(locks, "b", { locksAvailable: false, destroy: async () => {} });
  await expect(alone.node.destroy()).rejects.toBeInstanceOf(CoordinationUnavailableError);
});

test("a failed delete leaves the node closed and can be retried", async () => {
  const { locks } = installTabs();
  const destroy = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("blocked"))
    .mockResolvedValue(undefined);
  const node = startNode(locks, "a", { destroy });
  await settle();
  await expect(node.node.destroy()).rejects.toThrow("blocked");
  await expect(exec(node.node, "GET")).rejects.toBeInstanceOf(DBStorageDestroyedError);
  await node.node.destroy();
  expect(destroy).toHaveBeenCalledTimes(2);
  expect(locks.held.size).toBe(0);
});

test("a context that never closes delays the delete by the request timeout only", async () => {
  const { locks } = installTabs();
  // A hung context: its lifetime lock stays held.
  void locks.request(clientLockName("default", "hung"), { mode: "exclusive" }, () => {
    return new Promise(() => {});
  });
  const destroy = vi.fn(async () => {});
  const node = startNode(locks, "a", { destroy, requestTimeoutMs: 20 });
  await settle();
  await node.node.destroy();
  expect(destroy).toHaveBeenCalledOnce();
});

test("a context that takes the lead during the delete is closed too", async () => {
  const { locks } = installTabs();
  void locks.request(clientLockName("default", "hung"), { mode: "exclusive" }, () => {
    return new Promise(() => {});
  });
  const destroy = vi.fn(async () => {});
  const caller = startNode(locks, "a", { destroy, requestTimeoutMs: 40 });
  await settle();
  const deleting = caller.node.destroy();
  await settle();
  // Opened after the destroy message went out, while the caller waits for the hung context.
  const late = startNode(locks, "b", { destroy });
  await deleting;
  expect(late.engines).toHaveLength(1);
  expect(late.engines[0]!.close).toHaveBeenCalledOnce();
  expect(late.destroyed).toHaveBeenCalledOnce();
  expect(FakeBroadcastChannel.messages("destroy").length).toBeGreaterThan(1);
});

test("without locks.query, the delete only waits for the leader lock", async () => {
  const { locks } = installTabs();
  const destroy = vi.fn(async () => {});
  const leader = startNode(locks, "a", { destroy });
  await settle();
  const caller = startNode(locks, "b", { destroy });
  await settle();
  locks.query.mockResolvedValueOnce({} as never);
  await caller.node.destroy();
  expect(leader.destroyed).toHaveBeenCalledOnce();

  const { locks: bare } = installTabs();
  (bare as Partial<FakeLockManager>).query = undefined;
  const only = startNode(bare, "c", { destroy });
  await settle();
  await only.node.destroy();
  expect(destroy).toHaveBeenCalledTimes(2);
});

// --- Worker storages (page side) ---

function workerStorage(
  locks: FakeLockManager,
  tag: string,
  destroy: ((options: unknown) => Promise<void>) | undefined,
  disk = createDisk(),
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
  const open = () => memoryEngine(disk);
  startDBStorageWorker(destroy ? { open, destroy } : { open }, scope as never);
  const terminate = vi.fn();
  const storage = createWorkerDBStorage({
    dialect: "sqlite",
    worker: () => Object.assign(port1, { terminate }) as never,
    engineOptions: { file: "todo.db" },
  });
  return { storage, terminate };
}

test("worker storages delete the database in every context and close", async () => {
  const { locks } = installTabs();
  const disk = createDisk();
  const destroy = vi.fn(async () => disk.rows.clear());
  const a = workerStorage(locks, "a", destroy, disk);
  await a.storage.ready;
  const b = workerStorage(locks, "b", destroy, disk);
  await b.storage.ready;
  await b.storage.exec(q("SET a 1"));

  const destroyedA = vi.fn();
  const destroyedB = vi.fn();
  a.storage.onDestroyed!(() => {
    throw new Error("observer failed");
  });
  a.storage.onDestroyed!(destroyedA);
  b.storage.onDestroyed!(destroyedB);
  const unsubscribed = vi.fn();
  b.storage.onDestroyed!(unsubscribed)();

  await b.storage.destroy!();
  expect(destroy).toHaveBeenCalledWith({ file: "todo.db" });
  expect(disk.rows.size).toBe(0);
  // This context's listeners hear of its own delete; the other context's are told.
  expect(destroyedB).toHaveBeenCalledOnce();
  expect(unsubscribed).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(destroyedA).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(a.terminate).toHaveBeenCalled());
  expect(b.terminate).toHaveBeenCalled();
  await expect(a.storage.exec(q("GET", "all"))).rejects.toBeInstanceOf(DBStorageDestroyedError);
  await expect(b.storage.exec(q("GET", "all"))).rejects.toBeInstanceOf(DBStorageDestroyedError);
  await a.storage.destroy!();
  await b.storage.destroy!();
  expect(destroy).toHaveBeenCalledOnce();
});

test("a worker without a destroy function rejects, and a closed storage cannot delete", async () => {
  const { locks } = installTabs();
  const a = workerStorage(locks, "a", undefined);
  await a.storage.ready;
  await expect(a.storage.destroy!()).rejects.toBeInstanceOf(DBStorageDestroyUnsupportedError);
  // Still usable.
  await a.storage.exec(q("SET a 1"));
  await a.storage.close();
  await expect(a.storage.destroy!()).rejects.toBeInstanceOf(DBStorageClosedError);
});

test("a worker that failed to load cannot delete, and the runtime rejects destroy before init", async () => {
  const endpoint = Object.assign(new EventTarget(), { postMessage: vi.fn(), onmessage: null });
  const storage = createWorkerDBStorage({ dialect: "sqlite", worker: () => endpoint as never });
  endpoint.dispatchEvent(Object.assign(new Event("error"), { message: "404" }));
  await expect(storage.destroy!()).rejects.toThrow("404");

  const posted: any[] = [];
  const scope = { postMessage: (message: unknown) => posted.push(message), onmessage: null as any };
  startDBStorageWorker(() => memoryEngine(), scope as never);
  scope.onmessage({ data: { t: "destroy", id: 1 } } as MessageEvent);
  expect(posted).toEqual([
    { t: "started" },
    expect.objectContaining({ t: "response", id: 1, ok: false }),
  ]);
});

test("requests waiting in a page when the database is deleted elsewhere reject as destroyed", async () => {
  const endpoint = { postMessage: vi.fn(), onmessage: null as any };
  const storage = createWorkerDBStorage({ dialect: "sqlite", worker: () => endpoint });
  const pending = storage.exec(q("GET", "all"));
  const assertion = expect(pending).rejects.toBeInstanceOf(DBStorageDestroyedError);
  const ready = expect(storage.ready).rejects.toBeInstanceOf(DBStorageDestroyedError);
  endpoint.onmessage({ data: { t: "destroyed" } });
  // The page asks its worker to close; answer it.
  const close = endpoint.postMessage.mock.calls.at(-1)![0];
  expect(close).toMatchObject({ t: "close" });
  endpoint.onmessage({ data: { t: "response", id: close.id, ok: true } });
  await assertion;
  await ready;
});

// --- Local storage ---

test("local storage closes its engine, then deletes the database", async () => {
  const engine = memoryEngine();
  const destroy = vi.fn(async () => {
    expect(engine.close).toHaveBeenCalledOnce();
  });
  const storage = createLocalDBStorage({ dialect: "sqlite", open: () => engine, destroy });
  await storage.exec(q("SET a 1"));
  const destroyed = vi.fn();
  storage.onDestroyed!(() => {
    throw new Error("observer failed");
  });
  storage.onDestroyed!(destroyed);
  storage.onDestroyed!(vi.fn())();
  await storage.destroy!();
  await storage.destroy!();
  expect(destroy).toHaveBeenCalledOnce();
  expect(destroyed).toHaveBeenCalledOnce();
  await expect(storage.exec(q("GET", "all"))).rejects.toBeInstanceOf(DBStorageDestroyedError);
});

test("local storage without a destroy function rejects; a failed delete can be retried", async () => {
  const plain = createLocalDBStorage({ dialect: "sqlite", open: () => memoryEngine() });
  await expect(plain.destroy!()).rejects.toBeInstanceOf(DBStorageDestroyUnsupportedError);

  const destroy = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("blocked"))
    .mockResolvedValue(undefined);
  const storage = createLocalDBStorage({ dialect: "sqlite", open: () => memoryEngine(), destroy });
  await expect(storage.destroy!()).rejects.toThrow("blocked");
  await expect(storage.exec(q("GET", "all"))).rejects.toBeInstanceOf(DBStorageClosedError);
  await storage.destroy!();
  expect(destroy).toHaveBeenCalledTimes(2);
});

// --- Sync clients ---

function client(dbStorage = fakeDBStorage({ destroyable: true }), extra = {}) {
  const db = makeDb(undefined, undefined, dbStorage);
  db.close = vi.fn(async () => {});
  // Pushes never finish: written rows stay in the outbox.
  const syncAdapter = { push: vi.fn(() => new Promise(() => {})), pull: vi.fn(() => () => {}) };
  const syncClient = new SyncClientImpl(
    clientConfig(db, { syncAdapter, ...extra }),
    new ChangeBus<any>() as never,
  );
  return { syncClient, db, dbStorage };
}

test("destroy refuses while writes are unpushed and keeps the client running", async () => {
  const { syncClient, dbStorage } = client();
  await syncClient.collections.todos.insert({ id: "t1" } as never);
  const error = await syncClient.destroy().catch((error: unknown) => error);
  expect(error).toBeInstanceOf(PendingWritesError);
  expect(error).toMatchObject({ pending: { total: 1, rejected: 0, byCollection: { todos: 1 } } });
  expect(dbStorage.destroy).not.toHaveBeenCalled();
  await syncClient.collections.todos.insert({ id: "t2" } as never);
  expect((await syncClient.getPendingWrites()).total).toBe(2);
});

test("destroy with discard disposes the client and deletes the database", async () => {
  const onSyncStatus = vi.fn();
  const { syncClient, db, dbStorage } = client(undefined, { onSyncStatus });
  await syncClient.collections.todos.insert({ id: "t1" } as never);
  const destroyed = vi.fn();
  syncClient.subscribeDestroyed(() => {
    throw new Error("observer failed");
  });
  syncClient.subscribeDestroyed(destroyed);
  syncClient.subscribeDestroyed(vi.fn())();
  syncClient.startSync();
  await syncClient.dispose({ deleteDatabase: true, ifPendingWrites: "discard" });
  expect(db.close).toHaveBeenCalledOnce();
  expect(dbStorage.destroy).toHaveBeenCalledOnce();
  expect(dbStorage.close).not.toHaveBeenCalled();
  expect(destroyed).toHaveBeenCalledOnce();
  expect(onSyncStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: "stopped" }));

  // Safe to call twice; late subscribers are told at once.
  await syncClient.destroy();
  expect(dbStorage.destroy).toHaveBeenCalledOnce();
  const late = vi.fn();
  syncClient.subscribeDestroyed(late)();
  expect(late).toHaveBeenCalledOnce();
});

test("an empty outbox is deleted without options; the storage is deleted even if the adapter fails to close", async () => {
  const { syncClient, db, dbStorage } = client();
  db.close.mockRejectedValueOnce(new Error("adapter close failed"));
  await expect(syncClient.destroy()).rejects.toThrow("adapter close failed");
  expect(dbStorage.destroy).toHaveBeenCalledOnce();
});

test("a database deleted by another context disposes the client and tells the app", async () => {
  const statuses: string[] = [];
  const { syncClient, db, dbStorage } = client();
  syncClient.subscribeStatus(({ status }) => statuses.push(status));
  const destroyed = vi.fn();
  syncClient.subscribeDestroyed(destroyed);
  syncClient.startSync();
  const waiting = syncClient.waitForPushed();
  dbStorage.destroyRemotely();
  await expect(waiting).rejects.toMatchObject({ reason: "disposed" });
  expect(destroyed).toHaveBeenCalledOnce();
  expect(statuses.at(-1)).toBe("stopped");
  await settle();
  expect(db.close).toHaveBeenCalledOnce();
  // Already gone: deleting again resolves without asking the storage.
  await syncClient.destroy();
  expect(dbStorage.destroy).not.toHaveBeenCalled();

  // The adapter failing to close afterwards is not reported.
  const second = client();
  second.db.close.mockRejectedValueOnce(new Error("gone"));
  second.dbStorage.destroyRemotely();
  await settle();
  expect(second.db.close).toHaveBeenCalledOnce();
});

test("a storage that cannot delete rejects destroy, and plain dispose still closes it", async () => {
  const { syncClient, dbStorage } = client(fakeDBStorage());
  await expect(syncClient.destroy()).rejects.toBeInstanceOf(DBStorageDestroyUnsupportedError);
  await syncClient.dispose();
  expect(dbStorage.close).toHaveBeenCalledOnce();
});
