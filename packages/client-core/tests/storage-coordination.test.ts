import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { ChangeBus } from "../src/change-bus";
import type { LocalMutation } from "../src/collection/local-mutation";
import {
  createCoordinatedStorage,
  StorageOwnerUnavailableError,
} from "../src/storage-coordination";
import { StorageCoordinator } from "../src/storage-coordination/coordinator";
import { SyncClientImpl } from "../src/sync-client/sync-client";
import {
  atomicMemoryStore,
  clientConfig,
  createEngine,
  makeDb,
  settle,
  tick,
} from "./helpers/storage";
import {
  crashTab,
  FakeBroadcastChannel,
  FakeLockManager,
  installTabs,
  tabHost,
} from "./helpers/tabs";

type Request = { op: "get"; id: string } | { op: "throw"; value: unknown };

/** One persisted engine (rows + outbox) reopened by whichever tab owns it. */
function engineFixture(overrides: { flush?: () => Promise<void> } = {}) {
  const engine = createEngine();
  const store = atomicMemoryStore();
  const dbs: any[] = [];
  const execute = vi.fn(async (request: Request) => {
    if (request.op === "throw") throw request.value;
    return engine.get(request.id);
  });
  const open = vi.fn(async () => {
    const db = makeDb(engine);
    dbs.push(db);
    return { database: db, execute, ...overrides };
  });
  const options = (extra: Record<string, unknown> = {}) =>
    ({
      open,
      connect: (send: (request: Request) => Promise<unknown>) => ({
        ...makeDb(createEngine()),
        get: (_n: string, id: string) => send({ op: "get", id }),
      }),
      createDBAdapter: (database: any) => database,
      createLocalChangeStore: () => store,
      ...extra,
    }) as any;
  return { engine, store, dbs, execute, open, options };
}

const mutation = (id: string, eventId = `event-${id}`): LocalMutation => ({
  type: "create",
  collection: "todos",
  id,
  recordId: id,
  eventId,
  createdAt: 1,
  data: { id },
});

let locks: FakeLockManager;
beforeEach(() => {
  FakeBroadcastChannel.reset();
  locks = new FakeLockManager();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function tab(fixture: ReturnType<typeof engineFixture>, tag: string, extra = {}) {
  const host = tabHost(locks, tag);
  const coordinator = new StorageCoordinator(fixture.options(extra), host as never, tag);
  return { coordinator, host };
}

test("worker contexts without a document coordinate through Web Locks", async () => {
  const fixture = engineFixture();
  const { document: _document, ...host } = tabHost(locks, "worker");
  const coordinator = new StorageCoordinator(
    fixture.options(),
    { ...host, importScripts: () => {} } as never,
    "worker",
  );
  await settle();
  expect(coordinator.role).toBe("owner");
  await coordinator.dispose();
});

test("coordinated storage reports role changes to its observers", async () => {
  installTabs();
  const fixture = engineFixture();
  const first = createCoordinatedStorage(fixture.options());
  await first.ready;
  const second = createCoordinatedStorage(fixture.options());
  const roles = vi.fn();
  second.onRoleChange(roles);
  await second.ready;
  expect(second.role).toBe("follower");
  expect(roles).not.toHaveBeenCalled();
  await first.dispose();
  await settle();
  expect(roles).toHaveBeenCalledExactlyOnceWith("owner");
  await second.dispose();
});

test("requests in flight when the owner crashes are retried against the next owner", async () => {
  const fixture = engineFixture();
  tab(fixture, "a");
  await settle();
  const b = tab(fixture, "b");
  const c = tab(fixture, "c");
  await settle();
  fixture.engine.set("existing", { id: "existing" });
  const bView = await b.coordinator.resolve();
  const cView = await c.coordinator.resolve();
  expect([bView.role, cView.role]).toEqual(["follower", "follower"]);

  const write = bView.mutations.commit(mutation("from-b"));
  const read = (cView.dbAdapter as any).get("todos", "existing");
  crashTab(locks, "a");
  await settle();

  expect(b.coordinator.role).toBe("owner");
  await expect(write).resolves.toBeUndefined();
  await expect(read).resolves.toEqual({ id: "existing" });
  expect(fixture.open).toHaveBeenCalledTimes(2);
  expect(fixture.engine.has("from-b")).toBe(true);
  expect(await fixture.store.getPendingEvents()).toHaveLength(1);
  // The old proxy keeps working after promotion: it now runs in place.
  await expect((bView.dbAdapter as any).get("todos", "existing")).resolves.toEqual({
    id: "existing",
  });
  await expect(bView.mutations.commit(mutation("again"))).resolves.toBeUndefined();
  await Promise.all([b.coordinator.dispose(), c.coordinator.dispose()]);
});

test("a retried write that races its original attempt is applied once", async () => {
  const fixture = engineFixture();
  const a = tab(fixture, "a");
  await settle();
  const b = tab(fixture, "b", { requestTimeoutMs: 5 });
  await settle();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const ownerDb = fixture.dbs[0];
  const commit = ownerDb.commitLocalMutation;
  ownerDb.commitLocalMutation = vi.fn(async (options: any) => {
    await gate;
    return commit(options);
  });

  const write = (await b.coordinator.resolve()).mutations.commit(mutation("slow"));
  await new Promise((resolve) => setTimeout(resolve, 15));
  release();
  await expect(write).resolves.toBeUndefined();
  await settle();
  expect(ownerDb.commitLocalMutation).toHaveBeenCalledOnce();
  expect(await fixture.store.getPendingEvents()).toHaveLength(1);
  expect(FakeBroadcastChannel.messages("changes")).toHaveLength(1);
  expect(FakeBroadcastChannel.messages("who-is-owner").length).toBeGreaterThan(1);
  await Promise.all([a.coordinator.dispose(), b.coordinator.dispose()]);
});

test("requests nobody answers fail as retriable owner-unavailable errors", async () => {
  // Another context holds the lock but never announces itself as owner.
  void locks.request("ez-sync:default", { mode: "exclusive" }, () => new Promise(() => {}));
  const fixture = engineFixture();
  const b = tab(fixture, "b", { requestTimeoutMs: 2 });
  const follower = (b.coordinator as any).follower;
  const pending = follower.query({ op: "get", id: "x" });
  await expect(pending).rejects.toBeInstanceOf(StorageOwnerUnavailableError);
  await expect(pending).rejects.toMatchObject({ retriable: true });

  const stuck = follower.mutate(mutation("never"));
  follower.dispose();
  await expect(stuck).rejects.toBeInstanceOf(StorageOwnerUnavailableError);
  await b.coordinator.dispose();
});

test("a closing owner turns requests away and the follower waits for the next owner", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fixture = engineFixture({ flush: () => gate });
  const a = tab(fixture, "a");
  await settle();
  const b = tab(fixture, "b");
  const view = await b.coordinator.resolve();
  fixture.engine.set("k", { id: "k" });

  const disposing = a.coordinator.dispose();
  await tick();
  const read = (view.dbAdapter as any).get("todos", "k");
  await settle();
  expect(b.coordinator.role).toBe("follower");
  release();
  await disposing;
  await settle();
  expect(b.coordinator.role).toBe("owner");
  await expect(read).resolves.toEqual({ id: "k" });
  await b.coordinator.dispose();
});

test("owner failures reach the follower that asked", async () => {
  const fixture = engineFixture();
  const a = tab(fixture, "a");
  await settle();
  const b = tab(fixture, "b");
  const view = await b.coordinator.resolve();
  const follower = (b.coordinator as any).follower;
  await expect(follower.query({ op: "throw", value: "plain" })).rejects.toThrow("plain");
  await expect(follower.query({ op: "throw", value: new Error("typed") })).rejects.toThrow("typed");
  await view.mutations.commit(mutation("dup"));
  await expect(view.mutations.commit(mutation("dup", "other"))).rejects.toThrow("duplicate dup");
  await Promise.all([a.coordinator.dispose(), b.coordinator.dispose()]);
});

test("pagehide hands ownership over and pageshow from the cache rejoins", async () => {
  const fixture = engineFixture();
  const a = tab(fixture, "a");
  await settle();
  const b = tab(fixture, "b");
  await settle();
  // A live owner returning from the cache keeps its lock.
  a.host.listeners.get("pageshow")!({ persisted: true });
  expect(locks.request).toHaveBeenCalledTimes(2);

  a.host.listeners.get("pagehide")!({});
  await settle();
  expect(a.coordinator.role).toBe("follower");
  expect(b.coordinator.role).toBe("owner");
  expect((await a.coordinator.resolve()).commitsLocally).toBe(false);

  a.host.listeners.get("pageshow")!({ persisted: false });
  expect(locks.request).toHaveBeenCalledTimes(2);
  a.host.listeners.get("pageshow")!({ persisted: true });
  expect(locks.request).toHaveBeenCalledTimes(3);
  // Hiding and showing again before the queued request settles replaces it.
  a.host.listeners.get("pagehide")!({});
  a.host.listeners.get("pageshow")!({ persisted: true });
  await settle();
  expect(locks.request).toHaveBeenCalledTimes(4);

  await b.coordinator.dispose();
  await settle();
  expect(a.coordinator.role).toBe("owner");
  // Giving ownership up a second time reuses the same follower proxy.
  const firstFollowerView = (a.coordinator as any).followerView;
  a.host.listeners.get("pagehide")!({});
  await settle();
  expect(await a.coordinator.resolve()).toBe(firstFollowerView);
  await a.coordinator.dispose();
  a.host.listeners.get("pageshow")?.({ persisted: true });
  expect(a.host.listeners.size).toBe(0);
});

test("shared storage reports open failures and rejoins sync leadership after the cache", async () => {
  const sharedOptions = (open: () => unknown) =>
    ({
      sharing: "shared",
      open,
      createDBAdapter: (database: any) => database,
      createLocalChangeStore: () => atomicMemoryStore(),
    }) as never;
  const failing = new StorageCoordinator(
    sharedOptions(() => Promise.reject(new Error("shared open failed"))),
    tabHost(locks, "f") as never,
    "f",
  );
  await expect(failing.resolve()).rejects.toThrow("shared open failed");
  await failing.dispose();

  const host = tabHost(locks, "s");
  const shared = new StorageCoordinator(
    sharedOptions(() => ({ database: makeDb() })),
    host as never,
    "s",
  );
  await settle();
  expect(shared.role).toBe("owner");
  host.listeners.get("pagehide")!({});
  await settle();
  expect(shared.role).toBe("follower");
  host.listeners.get("pageshow")!({ persisted: true });
  await settle();
  expect(shared.role).toBe("owner");
  expect(FakeBroadcastChannel.messages("who-is-owner")).toHaveLength(0);
  await shared.dispose();
});

test("a context that cannot open the database lets the next one own it", async () => {
  const fixture = engineFixture();
  const errors: unknown[] = [];
  fixture.open.mockRejectedValueOnce(new Error("open failed"));
  const a = tab(fixture, "a");
  a.coordinator.subscribe({ error: (error) => errors.push(error) });
  await expect(a.coordinator.resolve()).rejects.toThrow("open failed");
  const b = tab(fixture, "b");
  await settle();
  expect(b.coordinator.role).toBe("owner");
  expect(errors).toEqual([expect.objectContaining({ message: "open failed" })]);
  // The failed context still reaches the storage as a follower.
  expect((await a.coordinator.resolve()).role).toBe("follower");
  await Promise.all([a.coordinator.dispose(), b.coordinator.dispose()]);
});

test("disposing while the database opens still closes it cleanly", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const close = vi.fn(async () => {});
  const fixture = engineFixture();
  fixture.open.mockImplementationOnce(async () => {
    await gate;
    return { database: makeDb(fixture.engine), execute: fixture.execute, close } as never;
  });
  const a = tab(fixture, "a");
  await tick();
  const disposing = a.coordinator.dispose();
  release();
  await disposing;
  expect(close).toHaveBeenCalledOnce();
  expect(FakeBroadcastChannel.messages("owner-bye")).toHaveLength(1);

  const sharedClose = vi.fn(async () => {});
  let releaseShared!: () => void;
  const sharedGate = new Promise<void>((resolve) => (releaseShared = resolve));
  const shared = new StorageCoordinator(
    {
      sharing: "shared",
      open: async () => {
        await sharedGate;
        return { database: makeDb(), close: sharedClose };
      },
      createDBAdapter: (database: any) => database,
      createLocalChangeStore: () => atomicMemoryStore(),
    } as never,
    tabHost(locks, "s") as never,
    "s",
  );
  const sharedDisposing = shared.dispose();
  releaseShared();
  await sharedDisposing;
  await settle();
  await expect(shared.resolve()).rejects.toThrow("disposed");
});

test("lock request failures are reported", async () => {
  const fixture = engineFixture();
  locks.request.mockImplementationOnce(() => Promise.reject(new Error("locks broken")));
  const a = tab(fixture, "a");
  await expect(a.coordinator.resolve()).rejects.toThrow("locks broken");
  await a.coordinator.dispose();
});

test("control messages are tolerated: duplicates, foreign epochs, gaps, and stray hellos", async () => {
  const fixture = engineFixture();
  const a = tab(fixture, "a");
  await settle();
  const b = tab(fixture, "b");
  await settle();
  const invalidated = vi.fn();
  const ownerInvalidated = vi.fn();
  const changes = vi.fn();
  b.coordinator.subscribe({ invalidate: invalidated, changes });
  a.coordinator.subscribe({ invalidate: ownerInvalidated });
  const shared = new StorageCoordinator(
    {
      sharing: "shared",
      open: () => ({ database: makeDb() }),
      createDBAdapter: (database: any) => database,
      createLocalChangeStore: () => atomicMemoryStore(),
    } as never,
    { ...tabHost(locks, "s"), navigator: { onLine: true } } as never,
    "s",
  );
  await settle();

  const epoch = FakeBroadcastChannel.messages("owner-hello")[0].epoch;
  const raw = new FakeBroadcastChannel("ez-sync:default");
  raw.postMessage(null);
  raw.postMessage({ t: "owner-hello", epoch });
  raw.postMessage({ t: "owner-bye", epoch: "someone-else" });
  const event = { type: "delete", collection: "todos", id: "1" };
  raw.postMessage({
    t: "changes",
    sender: "x",
    seq: 1,
    origin: "x",
    source: "pull",
    events: [event],
  });
  raw.postMessage({
    t: "changes",
    sender: "x",
    seq: 3,
    origin: "x",
    source: "pull",
    events: [event],
  });
  raw.postMessage({ t: "changes", sender: "x", seq: 4, origin: "x", source: "pull", events: [] });
  await settle();
  expect(invalidated).toHaveBeenCalledOnce();
  expect(ownerInvalidated).toHaveBeenCalledOnce();
  expect(changes).toHaveBeenCalledTimes(2);

  raw.postMessage({ t: "owner-hello", epoch: "new-epoch" });
  await settle();
  // Only the follower reacts to a new owner; the owner and the shared tab ignore it.
  expect(invalidated).toHaveBeenCalledTimes(2);
  expect(ownerInvalidated).toHaveBeenCalledOnce();
  expect(a.coordinator.role).toBe("owner");
  expect(shared.role).toBe("owner");
  await Promise.all([a.coordinator.dispose(), b.coordinator.dispose(), shared.dispose()]);
});

test("missed notifications rerun every live query of a sync client", async () => {
  installTabs();
  const fixture = engineFixture();
  const storage = createCoordinatedStorage(fixture.options());
  const syncClient = new SyncClientImpl(clientConfig(storage), new ChangeBus<any>() as never);
  const data = vi.fn();
  syncClient.liveQuery({ query: () => 1, onData: data });
  await settle();
  data.mockClear();
  const raw = new FakeBroadcastChannel("ez-sync:default");
  raw.postMessage({ t: "changes", sender: "x", seq: 1, origin: "x", source: "pull", events: [] });
  raw.postMessage({ t: "changes", sender: "x", seq: 5, origin: "x", source: "pull", events: [] });
  await settle();
  expect(data).toHaveBeenCalledOnce();
  await syncClient.dispose();
});

test("a lease granted after disposal is released immediately", async () => {
  const store = { ...atomicMemoryStore(), supportsCrossContextLeases: true };
  let grant!: (token: number) => void;
  vi.spyOn(store, "acquireLease").mockImplementationOnce(
    () => new Promise<number | undefined>((resolve) => (grant = resolve)),
  );
  const releaseLease = vi.spyOn(store, "releaseLease");
  const shared = new StorageCoordinator(
    {
      sharing: "shared",
      open: () => ({ database: makeDb() }),
      createDBAdapter: (database: any) => database,
      createLocalChangeStore: () => store,
    } as never,
    { ...tabHost(locks, "s"), navigator: { onLine: true } } as never,
    "s",
  );
  await settle();
  await shared.dispose();
  grant(7);
  await settle();
  expect(releaseLease).toHaveBeenCalledWith("default", "s", 7);
});

test("an empty lease answer after disposal needs no release", async () => {
  const store = { ...atomicMemoryStore(), supportsCrossContextLeases: true };
  let grant!: (token: number | undefined) => void;
  vi.spyOn(store, "acquireLease").mockImplementationOnce(
    () => new Promise<number | undefined>((resolve) => (grant = resolve)),
  );
  const releaseLease = vi.spyOn(store, "releaseLease");
  const shared = new StorageCoordinator(
    {
      sharing: "shared",
      open: () => ({ database: makeDb() }),
      createDBAdapter: (database: any) => database,
      createLocalChangeStore: () => store,
    } as never,
    { ...tabHost(locks, "s"), navigator: { onLine: true } } as never,
    "s",
  );
  await settle();
  await shared.dispose();
  grant(undefined);
  await settle();
  expect(releaseLease).not.toHaveBeenCalled();
});
