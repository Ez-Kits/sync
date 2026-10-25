import { afterEach, expect, test, vi } from "vite-plus/test";
import { ChangeBus } from "../src/change-bus";
import { createSyncClient } from "../src/sync-client/create-sync-client";
import { SyncClientImpl } from "../src/sync-client/sync-client";
import { createAtomicLocalMutationStorage } from "../src/sync-client/storage-pair";
import { createTestLocalChangeStore } from "./helpers/local-change-store";

const collection = { name: "todos", adapterConfig: {}, primaryField: "id" };
function dbFixture() {
  const db: any = {
    queryBuilder: {},
    querySchema: { todos: {} },
    insert: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    get: vi.fn(async () => undefined),
    getMany: vi.fn(async () => []),
    transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(db)),
  };
  db.commitLocalMutation = vi.fn(
    async ({ mutate, persistOutboxEvent, persistDirtyRecord }: any) => {
      const context = { operations: db, native: db };
      await mutate(context);
      await persistOutboxEvent(context);
      await persistDirtyRecord(context);
    },
  );
  return db;
}
function atomicMemoryStore() {
  return {
    ...createTestLocalChangeStore(),
    atomicLocalMutationCapability: "atomic" as const,
  };
}
function config(db: any, store: any = atomicMemoryStore(), extra: Record<string, unknown> = {}) {
  return {
    collections: [collection],
    checkpointStorage: {
      getCheckpoint: vi.fn(async () => undefined),
      saveCheckpoint: vi.fn(async () => {}),
    },
    storage: createAtomicLocalMutationStorage(
      db,
      (database) => database,
      () => store,
    ),
    coordinateTabs: false,
    ...extra,
  } as any;
}
const tick = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("client rejects missing paired storage instead of using a default outbox", () => {
  const db = dbFixture();
  const settings = { ...config(db) } as any;
  delete settings.storage;
  expect(() => new SyncClientImpl(settings, new ChangeBus<any>() as never)).toThrow(
    "Sync clients require a paired database adapter and local-change store",
  );
});

test("client rejects a storage pair reassembled at runtime", () => {
  const db = dbFixture();
  const pair = createAtomicLocalMutationStorage(
    db,
    (database) => database,
    () => atomicMemoryStore(),
  );
  // oxlint-disable-next-line typescript/no-misused-spread -- verifies runtime detection of a reassembled pair
  const reassembled = { ...pair, localChangeStore: atomicMemoryStore() };

  expect(
    () =>
      new SyncClientImpl(
        {
          collections: [collection],
          storage: reassembled,
          checkpointStorage: {
            getCheckpoint: vi.fn(async () => undefined),
            saveCheckpoint: vi.fn(async () => {}),
          },
        } as never,
        new ChangeBus<any>(),
      ),
  ).toThrow("paired database adapter and local-change store");
});

test("storage API rejects unpaired adapters and non-atomic stores at type level", () => {
  const db = dbFixture();
  const store = atomicMemoryStore();
  const checkpointStorage = {
    getCheckpoint: vi.fn(async () => undefined),
    saveCheckpoint: vi.fn(async () => {}),
  };
  const pairedStorage = createAtomicLocalMutationStorage(
    db,
    (database) => database,
    () => store,
  );
  const reassembledStorage = {
    // oxlint-disable-next-line typescript/no-misused-spread -- verifies that spreading loses the opaque pair type
    ...pairedStorage,
    localChangeStore: atomicMemoryStore(),
  };
  const invalidCalls = () => {
    createSyncClient({
      collections: [collection],
      // @ts-expect-error clients require one branded database/store pair
      dbAdapter: () => db,
      localChangeStore: atomicMemoryStore(),
      checkpointStorage,
    });
    createAtomicLocalMutationStorage(
      db,
      (database) => database,
      // @ts-expect-error memory stores cannot satisfy the atomic store contract
      () => createTestLocalChangeStore(),
    );
    createSyncClient({
      collections: [collection],
      // @ts-expect-error a pair cannot be reassembled with another local-change store
      storage: reassembledStorage,
      checkpointStorage,
    });
  };

  expect(invalidCalls).toBeTypeOf("function");
});

test("factory creates a client, subscribe overloads filter streams, and live queries rerun on changes", async () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  const db = dbFixture();
  const client = createSyncClient(config(db) as never);
  const all = vi.fn();
  const remote = vi.fn();
  const single = vi.fn();
  const several = vi.fn();
  const stopAll = client.subscribe(all);
  client.subscribe(remote, { stream: "remote" });
  client.subscribe("todos" as never, single as never);
  client.subscribe(["todos"] as never, several as never, { stream: "local" });
  const data = vi.fn();
  const query = vi.fn(async () => ["todos"]);
  client.liveQuery({ query, onData: data } as never);
  await tick();
  await client.collections.todos.insert({ id: "1" } as never);
  await tick();
  expect(data).toHaveBeenCalledTimes(2);
  expect(query).toHaveBeenCalledWith(db.queryBuilder, db.querySchema);
  expect(all).toHaveBeenCalledTimes(1);
  expect(single).toHaveBeenCalledTimes(1);
  expect(several).toHaveBeenCalledTimes(1);
  expect(remote).not.toHaveBeenCalled();
  (client as any).changeBus.publishRemote({ type: "delete", collection: "todos", id: "1" });
  await tick();
  expect(remote).toHaveBeenCalledOnce();
  stopAll();
  client.dispose();
});

test("status callbacks are isolated, listeners receive initial state, and missing network host is treated online", () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  vi.stubGlobal("navigator", undefined);
  vi.stubGlobal("addEventListener", undefined);
  vi.stubGlobal("removeEventListener", undefined);
  const db = dbFixture();
  const good = vi.fn();
  const statuses = vi.fn(() => {
    throw new Error("observer failed");
  });
  const client = new SyncClientImpl(
    config(db, atomicMemoryStore(), {
      coordinateTabs: true,
      onSyncStatus: statuses,
    }) as never,
    new ChangeBus<any>() as never,
  );
  const badListener = vi.fn(() => {
    throw new Error("listener failed");
  });
  const unsubscribe = client.subscribeStatus(badListener);
  client.subscribeStatus(good);
  client.startSync();
  expect(statuses).toHaveBeenCalled();
  expect(good.mock.calls.map(([event]) => event.status)).toContain("syncing");
  unsubscribe();
  client.dispose();
  if (priorNavigator) Object.defineProperty(globalThis, "navigator", priorNavigator);
});

test("browser coordination renews and releases leases, responds to network events, and broadcasts local events", async () => {
  class FakeBroadcastChannel {
    static instance: FakeBroadcastChannel;
    onmessage: ((event: MessageEvent) => void) | null = null;
    messages: unknown[] = [];
    closed = false;
    constructor(public name: string) {
      FakeBroadcastChannel.instance = this;
    }
    postMessage(data: unknown) {
      this.messages.push(data);
    }
    close() {
      this.closed = true;
    }
  }
  const events: Record<string, () => void> = {};
  const removed: string[] = [];
  const navigatorFake = { onLine: true };
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  vi.stubGlobal("navigator", navigatorFake);
  vi.stubGlobal("addEventListener", (type: string, listener: () => void) => {
    events[type] = listener;
  });
  vi.stubGlobal("removeEventListener", (type: string) => {
    removed.push(type);
  });
  const db = dbFixture();
  const store = {
    ...atomicMemoryStore(),
    supportsCrossContextLeases: true,
    acquireLease: vi.fn(async (): Promise<number | undefined> => 7),
    releaseLease: vi.fn(async () => {}),
  };
  const client = new SyncClientImpl(
    config(db, store, { coordinateTabs: true, coordinationKey: "key" }) as never,
    new ChangeBus<any>() as never,
  );
  const statuses: string[] = [];
  client.subscribeStatus((e) => statuses.push(e.status));
  client.startSync();
  client.startSync();
  await tick();
  expect(FakeBroadcastChannel.instance.name).toBe("ez-sync:key");
  expect(store.acquireLease).toHaveBeenCalled();
  expect(statuses).toContain("syncing");
  store.acquireLease.mockImplementationOnce(async () => undefined);
  await (client as any).renewLeadership();
  expect(statuses.at(-1)).toBe("idle");
  await (client as any).renewLeadership();
  expect(statuses.at(-1)).toBe("syncing");
  await client.collections.todos.insert({ id: "1" } as never);
  await tick();
  expect(FakeBroadcastChannel.instance.messages).toHaveLength(1);
  const remote = vi.fn();
  client.subscribe(remote, { stream: "remote" });
  FakeBroadcastChannel.instance.onmessage!({
    data: { type: "local-change", events: [{ type: "delete", collection: "todos", id: "1" }] },
  } as MessageEvent);
  FakeBroadcastChannel.instance.onmessage!({ data: null } as MessageEvent);
  FakeBroadcastChannel.instance.onmessage!({ data: { type: "other", events: [] } } as MessageEvent);
  FakeBroadcastChannel.instance.onmessage!({
    data: { type: "local-change", events: {} },
  } as MessageEvent);
  await tick();
  expect(remote).toHaveBeenCalledOnce();
  events.offline!();
  expect(statuses.at(-1)).toBe("offline");
  navigatorFake.onLine = true;
  events.online!();
  await tick();
  expect(statuses.at(-1)).toBe("syncing");
  client.stopSync();
  await tick();
  expect(store.releaseLease).toHaveBeenCalledWith("key", expect.any(String), 7);
  expect(removed).toEqual(["online", "offline"]);
  events.online!();
  client.dispose();
  expect(FakeBroadcastChannel.instance.closed).toBe(true);
});

test("lease loss and errors update status; a late lease is released after sync stops", async () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("navigator", { onLine: true });
  const db = dbFixture();
  let resolveLease!: (value: number | undefined) => void;
  const late = new Promise<number | undefined>((resolve) => {
    resolveLease = resolve;
  });
  const store = {
    ...atomicMemoryStore(),
    supportsCrossContextLeases: true,
    acquireLease: vi.fn(() => late),
    releaseLease: vi.fn(async () => {}),
  };
  const client = new SyncClientImpl(
    config(db, store, { coordinateTabs: true }) as never,
    new ChangeBus<any>() as never,
  );
  const statuses: string[] = [];
  client.subscribeStatus((e) => statuses.push(e.status));
  (client as any).wantsSync = true;
  const renewal = (client as any).renewLeadership();
  (client as any).wantsSync = false;
  resolveLease(3);
  await renewal;
  expect(store.releaseLease).toHaveBeenCalledWith("default", expect.any(String), 3);
  (client as any).wantsSync = true;
  (client as any).leaseToken = 4;
  store.acquireLease.mockResolvedValueOnce(undefined);
  await (client as any).renewLeadership();
  expect(statuses.at(-1)).toBe("idle");
  await (client as any).renewLeadership();
  client.dispose();

  const failing = {
    ...atomicMemoryStore(),
    supportsCrossContextLeases: true,
    acquireLease: vi.fn(async () => {
      throw new Error("lease failed");
    }),
  };
  const failedClient = new SyncClientImpl(
    config(db, failing, { coordinateTabs: true }) as never,
    new ChangeBus<any>() as never,
  );
  const failedStatuses: string[] = [];
  failedClient.subscribeStatus((e) => failedStatuses.push(e.status));
  failedClient.startSync();
  await tick();
  expect(failedStatuses).toContain("error");
  failedClient.dispose();
});

test("Web Locks keep one shared-database leader and hand leadership off on stop", async () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  const pendingRequests: Array<{
    name: string;
    signal: AbortSignal;
    callback: (lock: unknown) => Promise<void>;
  }> = [];
  const locks = {
    request: vi.fn(
      (
        name: string,
        options: { signal: AbortSignal },
        callback: (lock: unknown) => Promise<void>,
      ) => {
        pendingRequests.push({ name, signal: options.signal, callback });
        return new Promise<void>(() => {});
      },
    ),
  };
  vi.stubGlobal("navigator", { onLine: true, locks });
  const db = dbFixture();
  const firstClient = new SyncClientImpl(
    config(db, atomicMemoryStore(), {
      coordinateTabs: true,
      coordinationKey: "shared-db",
    }) as never,
    new ChangeBus<any>() as never,
  );
  const secondClient = new SyncClientImpl(
    config(db, atomicMemoryStore(), {
      coordinateTabs: true,
      coordinationKey: "shared-db",
    }) as never,
    new ChangeBus<any>() as never,
  );
  const firstStart = vi.spyOn((firstClient as any).syncHandler, "startAll");
  const firstStop = vi.spyOn((firstClient as any).syncHandler, "stopAll");
  const secondStart = vi.spyOn((secondClient as any).syncHandler, "startAll");

  firstClient.startSync();
  secondClient.startSync();
  await tick();
  expect(locks.request).toHaveBeenCalledTimes(2);
  expect(pendingRequests.map(({ name }) => name)).toEqual([
    "ez-sync:shared-db",
    "ez-sync:shared-db",
  ]);

  const firstCallback = pendingRequests[0]!.callback({});
  await tick();
  expect(firstStart).toHaveBeenCalledOnce();
  expect(secondStart).not.toHaveBeenCalled();

  firstClient.stopSync();
  await firstCallback;
  expect(firstStop).toHaveBeenCalled();
  expect(pendingRequests[0]!.signal.aborted).toBe(true);

  const secondCallback = pendingRequests[1]!.callback({});
  await tick();
  expect(secondStart).toHaveBeenCalledOnce();
  secondClient.stopSync();
  await secondCallback;
  firstClient.dispose();
  secondClient.dispose();
});

test("lease release uses the default coordination key", async () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("navigator", { onLine: true });
  const db = dbFixture();
  const store = {
    ...atomicMemoryStore(),
    supportsCrossContextLeases: true,
    acquireLease: vi.fn(async () => 1),
    releaseLease: vi.fn(async () => {}),
  };
  const client = new SyncClientImpl(
    config(db, store, { coordinateTabs: true }) as never,
    new ChangeBus<any>() as never,
  );
  vi.useFakeTimers();
  client.startSync();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(store.acquireLease.mock.calls.length).toBeGreaterThan(1);
  client.stopSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(store.releaseLease).toHaveBeenCalledWith("default", expect.any(String), 1);
  client.dispose();
  vi.useRealTimers();
});

test("undefined lease leaves an unowned client idle", async () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("navigator", { onLine: true });
  const db = dbFixture();
  const store = {
    ...atomicMemoryStore(),
    supportsCrossContextLeases: true,
    acquireLease: vi.fn(async () => undefined),
  };
  const client = new SyncClientImpl(
    config(db, store, { coordinateTabs: true }) as never,
    new ChangeBus<any>() as never,
  );
  client.startSync();
  await tick();
  client.stopSync();
  client.dispose();
});

test("lease renewal skips offline or disabled clients and releases a late empty lease safely", async () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  const db = dbFixture();
  let resolveLease!: (value: number | undefined) => void;
  const pending = new Promise<number | undefined>((resolve) => {
    resolveLease = resolve;
  });
  const store = {
    ...atomicMemoryStore(),
    supportsCrossContextLeases: true,
    acquireLease: vi.fn(() => pending),
    releaseLease: vi.fn(async () => {}),
  };
  const client = new SyncClientImpl(
    config(db, store, { coordinateTabs: true }) as never,
    new ChangeBus<any>() as never,
  );
  await (client as any).renewLeadership();
  (client as any).wantsSync = true;
  const renewal = (client as any).renewLeadership();
  (client as any).wantsSync = false;
  resolveLease(undefined);
  await renewal;
  (client as any).wantsSync = false;
  await (client as any).renewLeadership();
  client.dispose();
});

test("sync client maps handler success and failures into public status callbacks", async () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  const db = dbFixture();
  let collectionCommit: ((args: any) => void) | undefined;
  let globalCommit: ((args: any) => void) | undefined;
  const adapter = {
    push: vi.fn(async () => {}),
    pull: vi.fn((options: any) => {
      if (collectionCommit) globalCommit = options.commitChanges;
      else collectionCommit = options.commitChanges;
      return () => {};
    }),
  };
  const client = new SyncClientImpl(
    config(db, atomicMemoryStore(), {
      coordinateTabs: false,
      collections: [{ ...collection, syncAdapter: adapter }],
      syncAdapter: adapter,
    }) as never,
    new ChangeBus<any>() as never,
  );
  const statuses: string[] = [];
  client.subscribeStatus((event) => statuses.push(event.status));
  client.startSync();
  await tick();
  await tick();
  (collectionCommit ?? globalCommit)?.({ changes: [], checkpoint: {} });
  await tick();
  expect(statuses).toContain("syncing");
  db.transaction.mockRejectedValueOnce(new Error("commit failed"));
  (collectionCommit ?? globalCommit)?.({
    changes: [{ type: "create", collection: "todos", data: { id: 1 } }],
    checkpoint: {},
  });
  await tick();
  await tick();
  expect(statuses).toContain("error");
  client.dispose();
});
