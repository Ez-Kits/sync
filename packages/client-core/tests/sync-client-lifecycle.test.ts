import { afterEach, expect, test, vi } from "vite-plus/test";
import { ChangeBus } from "../src/change-bus";
import {
  createCoordinatedStorage,
  CoordinationUnavailableError,
  FollowerWriteError,
} from "../src/storage-coordination";
import { createSyncClient } from "../src/sync-client/create-sync-client";
import { SyncClientImpl } from "../src/sync-client/sync-client";
import {
  atomicMemoryStore,
  clientConfig,
  collection,
  createEngine,
  makeDb,
  settle,
  standaloneStorage,
  tick,
} from "./helpers/storage";
import { FakeBroadcastChannel, installTabs } from "./helpers/tabs";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type ProxyRequest = { op: "get"; id: string } | { op: "getMany" } | { op: "fail" };

/** One persisted engine (rows + outbox) that only the current owner opens. */
function exclusiveFixture() {
  const engine = createEngine();
  const store = atomicMemoryStore();
  const execute = vi.fn(async (request: ProxyRequest) => {
    if (request.op === "fail") throw new Error("query failed");
    if (request.op === "get") return engine.get(request.id);
    return [...engine.values()];
  });
  const open = vi.fn(async () => ({ database: makeDb(engine), execute }));
  const storage = () =>
    createCoordinatedStorage({
      open,
      connect: (send: (request: ProxyRequest) => Promise<unknown>) => ({
        ...makeDb(createEngine()),
        queryBuilder: { send },
        get: (_n: string, id: string) => send({ op: "get", id }),
        getMany: () => send({ op: "getMany" }),
      }),
      createDBAdapter: (database: any) => database,
      createLocalChangeStore: () => store,
    });
  return { engine, store, open, execute, storage };
}

function sharedStorage(engine = createEngine(), store: any = atomicMemoryStore()) {
  return createCoordinatedStorage({
    sharing: "shared",
    open: () => ({ database: makeDb(engine) }),
    createDBAdapter: (database: any) => database,
    createLocalChangeStore: () => store,
  });
}

function recordingAdapter() {
  let commitPull: ((options: any) => void) | undefined;
  const adapter = {
    push: vi.fn(async ({ events, commitChanges }: any) => commitChanges({ events })),
    pull: vi.fn((options: any) => {
      commitPull = options.commitChanges;
      return () => {};
    }),
    commitPull: (options: any) => commitPull!(options),
  };
  return adapter;
}

function client(storage: unknown, extra: Record<string, unknown> = {}) {
  return new SyncClientImpl(clientConfig(storage, extra), new ChangeBus<any>() as never);
}

test("factory creates a client, subscribe overloads filter streams, and live queries rerun on changes", async () => {
  const db = makeDb();
  const syncClient = createSyncClient(clientConfig(standaloneStorage(db)) as never);
  const all = vi.fn();
  const remote = vi.fn();
  const single = vi.fn();
  const several = vi.fn();
  const stopAll = syncClient.subscribe(all);
  syncClient.subscribe(remote, { stream: "remote" });
  syncClient.subscribe("todos" as never, single as never);
  syncClient.subscribe(["todos"] as never, several as never, { stream: "local" });
  const data = vi.fn();
  const query = vi.fn(async () => ["todos"]);
  syncClient.liveQuery({ query, onData: data } as never);
  await tick();
  await syncClient.collections.todos.insert({ id: "1" } as never);
  await tick();
  expect(data).toHaveBeenCalledTimes(2);
  expect(query).toHaveBeenCalledWith(db.queryBuilder, db.querySchema);
  expect(all).toHaveBeenCalledTimes(1);
  expect(single).toHaveBeenCalledTimes(1);
  expect(several).toHaveBeenCalledTimes(1);
  expect(remote).not.toHaveBeenCalled();
  (syncClient as any).changeBus.publishRemote({ type: "delete", collection: "todos", id: "1" });
  await tick();
  expect(remote).toHaveBeenCalledOnce();
  stopAll();
  await syncClient.dispose();
});

test("status and role observers are isolated and receive the current state", async () => {
  vi.stubGlobal("navigator", undefined);
  vi.stubGlobal("addEventListener", undefined);
  vi.stubGlobal("removeEventListener", undefined);
  const good = vi.fn();
  const statuses = vi.fn(() => {
    throw new Error("observer failed");
  });
  const syncClient = client(standaloneStorage(), { onSyncStatus: statuses });
  const unsubscribe = syncClient.subscribeStatus(() => {
    throw new Error("listener failed");
  });
  syncClient.subscribeStatus(good);
  const roles = vi.fn();
  syncClient.subscribeStorageRole(() => {
    throw new Error("role listener failed");
  });
  const unsubscribeRole = syncClient.subscribeStorageRole(roles);
  syncClient.startSync();
  await tick();
  syncClient.startSync();
  expect(statuses).toHaveBeenCalled();
  expect(good.mock.calls.map(([event]) => event.status)).toContain("syncing");
  expect(roles.mock.calls.map(([role]) => role)).toEqual(["follower", "owner"]);
  unsubscribe();
  unsubscribeRole();
  await syncClient.dispose();
});

test("sync client maps handler success and failures into public status callbacks", async () => {
  const db = makeDb();
  const adapter = recordingAdapter();
  const syncClient = client(standaloneStorage(db), {
    collections: [{ ...collection, syncAdapter: adapter }],
  });
  const statuses: string[] = [];
  syncClient.subscribeStatus((event) => statuses.push(event.status));
  syncClient.startSync();
  await settle();
  adapter.commitPull({ changes: [], checkpoint: {} });
  await tick();
  expect(statuses).toContain("syncing");
  db.transaction.mockRejectedValueOnce(new Error("commit failed"));
  adapter.commitPull({
    changes: [{ type: "create", collection: "todos", data: { id: 1 } }],
    checkpoint: {},
  });
  await settle();
  expect(statuses).toContain("error");
  await syncClient.dispose();
});

test("going offline pauses sync without releasing storage ownership", async () => {
  const { locks } = installTabs();
  const listeners = new Map<string, () => void>();
  vi.stubGlobal("addEventListener", (type: string, listener: () => void) =>
    listeners.set(type, listener),
  );
  vi.stubGlobal("removeEventListener", (type: string) => listeners.delete(type));
  const adapter = recordingAdapter();
  const owner = client(sharedStorage(), { syncAdapter: adapter });
  const statuses: string[] = [];
  owner.subscribeStatus((event) => statuses.push(event.status));
  owner.startSync();
  await settle();
  expect(statuses.at(-1)).toBe("syncing");

  listeners.get("offline")!();
  expect(statuses.at(-1)).toBe("offline");
  listeners.get("online")!();
  expect(statuses.at(-1)).toBe("syncing");
  expect(locks.request).toHaveBeenCalledOnce();
  expect(owner.storageRole).toBe("owner");

  owner.stopSync();
  listeners.get("online")?.();
  expect(statuses.at(-1)).toBe("stopped");
  await owner.dispose();
});

test("shared storage: one lock holder syncs; follower writes reach its push and pulls reach followers", async () => {
  installTabs();
  const engine = createEngine();
  const store = atomicMemoryStore();
  const ownerAdapter = recordingAdapter();
  const followerAdapter = recordingAdapter();
  const owner = client(sharedStorage(engine, store), { syncAdapter: ownerAdapter });
  const follower = client(sharedStorage(engine, store), { syncAdapter: followerAdapter });
  const followerStatuses: string[] = [];
  follower.subscribeStatus((event) => followerStatuses.push(event.status));
  owner.startSync();
  follower.startSync();
  await settle();
  expect(owner.storageRole).toBe("owner");
  expect(follower.storageRole).toBe("follower");
  expect(followerStatuses.at(-1)).toBe("idle");
  expect(followerAdapter.pull).not.toHaveBeenCalled();

  const ownerRemote = vi.fn();
  owner.subscribe(ownerRemote, { stream: "remote" });
  await follower.collections.todos.insert({ id: "f1" } as never);
  await settle();
  expect(ownerRemote).toHaveBeenCalledOnce();
  expect(ownerAdapter.push).toHaveBeenCalledOnce();
  expect(followerAdapter.push).not.toHaveBeenCalled();
  expect(await store.getPendingEvents()).toEqual([]);

  const followerData = vi.fn();
  follower.liveQuery({ collections: ["todos"], query: async () => "rows", onData: followerData });
  await tick();
  followerData.mockClear();
  ownerAdapter.commitPull({
    changes: [{ type: "create", collection: "todos", data: { id: "remote" } }],
    checkpoint: {},
  });
  await settle();
  expect(followerData).toHaveBeenCalled();
  expect(FakeBroadcastChannel.messages("changes").map((m) => m.source)).toEqual(["local", "pull"]);

  await owner.dispose();
  await settle();
  expect(follower.storageRole).toBe("owner");
  expect(followerAdapter.pull).toHaveBeenCalled();
  await follower.dispose();
});

test("exclusive storage: only the owner opens the database; followers proxy reads and writes", async () => {
  installTabs();
  const fixture = exclusiveFixture();
  const ownerAdapter = recordingAdapter();
  const owner = client(fixture.storage(), { syncAdapter: ownerAdapter });
  await settle();
  const follower = client(fixture.storage(), { syncAdapter: recordingAdapter() });
  const third = client(fixture.storage());
  await settle();
  expect(fixture.open).toHaveBeenCalledOnce();
  expect([owner.storageRole, follower.storageRole, third.storageRole]).toEqual([
    "owner",
    "follower",
    "follower",
  ]);
  owner.startSync();
  follower.startSync();
  await settle();

  const followerLocal = vi.fn();
  const ownerRemote = vi.fn();
  const thirdRemote = vi.fn();
  follower.subscribe(followerLocal, { stream: "local" });
  owner.subscribe(ownerRemote, { stream: "remote" });
  third.subscribe(thirdRemote, { stream: "remote" });
  const thirdData = vi.fn();
  third.liveQuery({
    collections: ["todos"],
    query: (queryBuilder: any) => queryBuilder.send({ op: "getMany" }),
    onData: thirdData,
  });

  await follower.collections.todos.insert({ id: "f1", title: "from follower" } as never);
  await settle();
  expect(fixture.engine.get("f1")).toMatchObject({ title: "from follower" });
  expect(followerLocal).toHaveBeenCalledOnce();
  expect(ownerRemote).toHaveBeenCalledOnce();
  expect(thirdRemote).toHaveBeenCalledOnce();
  expect(ownerAdapter.push).toHaveBeenCalledOnce();
  expect(await fixture.store.getPendingEvents()).toEqual([]);
  // The owner announced the write once; nobody echoed it.
  expect(FakeBroadcastChannel.messages("changes")).toHaveLength(1);
  expect(thirdData.mock.calls.at(-1)?.[0]).toEqual([{ id: "f1", title: "from follower" }]);

  expect(await follower.collections.todos.get("f1" as never)).toMatchObject({ id: "f1" });
  await owner.collections.todos.update({ id: "f1", title: "owner" } as never);
  await settle();
  expect(FakeBroadcastChannel.messages("changes")).toHaveLength(2);
  expect(thirdRemote).toHaveBeenCalledTimes(2);

  await expect(
    (follower as any).coordinator.view.dbAdapter.transaction(async () => {}),
  ).rejects.toBeInstanceOf(FollowerWriteError);
  await expect(
    (follower as any).coordinator.view.dbAdapter.queryBuilder.send({ op: "fail" }),
  ).rejects.toThrow("query failed");

  await Promise.all([owner.dispose(), follower.dispose(), third.dispose()]);
});

test("exclusive storage hands ownership to a follower, which reopens and resumes sync", async () => {
  installTabs();
  const fixture = exclusiveFixture();
  const owner = client(fixture.storage());
  await settle();
  const followerAdapter = recordingAdapter();
  const follower = client(fixture.storage(), { syncAdapter: followerAdapter });
  follower.startSync();
  await settle();
  expect(followerAdapter.pull).not.toHaveBeenCalled();
  await follower.collections.todos.insert({ id: "before" } as never);
  const data = vi.fn();
  follower.liveQuery({
    query: (queryBuilder: any) => queryBuilder.rows?.size ?? "proxy",
    onData: data,
  });
  await tick();
  expect(data).toHaveBeenLastCalledWith("proxy");

  await owner.dispose();
  await settle();
  expect(fixture.open).toHaveBeenCalledTimes(2);
  expect(follower.storageRole).toBe("owner");
  expect(followerAdapter.pull).toHaveBeenCalled();
  // The outbox survived the handoff and the new owner pushed it.
  expect(followerAdapter.push).toHaveBeenCalledOnce();
  expect(data).toHaveBeenLastCalledWith(1);
  await follower.collections.todos.insert({ id: "after" } as never);
  expect(fixture.engine.has("after")).toBe(true);
  await follower.dispose();
});

test("exclusive storage reports unavailable coordination without Web Locks", async () => {
  installTabs({ locks: false });
  const statuses: Array<{ status: string; error?: unknown }> = [];
  const fixture = exclusiveFixture();
  const storage = fixture.storage();
  const syncClient = client(storage, { onSyncStatus: (event: any) => statuses.push(event) });
  await expect(storage.ready).rejects.toBeInstanceOf(CoordinationUnavailableError);
  await tick();
  expect(statuses.at(-1)?.error).toBeInstanceOf(CoordinationUnavailableError);
  expect(fixture.open).not.toHaveBeenCalled();
  await syncClient.dispose();
});

test("shared storage without Web Locks elects through outbox leases with fencing", async () => {
  installTabs({ locks: false });
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  try {
    const engine = createEngine();
    const store = { ...atomicMemoryStore(), supportsCrossContextLeases: true };
    const releaseLease = vi.spyOn(store, "releaseLease");
    const first = client(sharedStorage(engine, store), { syncAdapter: recordingAdapter() });
    const second = client(sharedStorage(engine, store), { syncAdapter: recordingAdapter() });
    await settle();
    expect(first.storageRole).toBe("owner");
    expect(second.storageRole).toBe("follower");
    const firstCoordinator = (first as any).coordinator;
    expect(firstCoordinator.canCommit(firstCoordinator.view)).toBe(true);
    vi.setSystemTime(Date.now() + 16_000);
    expect(firstCoordinator.canCommit(firstCoordinator.view)).toBe(false);
    expect(firstCoordinator.canCommit({ role: "owner" })).toBe(false);

    await first.dispose();
    expect(releaseLease).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(5_000);
    await settle();
    expect(second.storageRole).toBe("owner");

    vi.spyOn(store, "acquireLease").mockRejectedValueOnce(new Error("lease failed"));
    const statuses: string[] = [];
    second.subscribeStatus((event) => statuses.push(event.status));
    vi.advanceTimersByTime(5_000);
    await settle();
    expect(second.storageRole).toBe("follower");
    expect(statuses).toContain("error");
    await second.dispose();
  } finally {
    vi.useRealTimers();
  }
});

test("shared storage without any election lets every context sync", async () => {
  installTabs({ locks: false, channels: false });
  const syncClient = client(sharedStorage());
  await settle();
  expect(syncClient.storageRole).toBe("owner");
  await syncClient.collections.todos.insert({ id: "1" } as never);
  await syncClient.dispose();
});
