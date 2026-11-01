import { afterEach, expect, test, vi } from "vite-plus/test";
import { ChangeBus } from "../src/change-bus";
import {
  createLocalMutationSink,
  executeLocalMutation,
  isLocalMutationCommitted,
  type LocalMutation,
} from "../src/collection/local-mutation";
import { CollectionRuntime } from "../src/collection/runtime";
import { LeaderChangedError } from "../src/db-storage";
import { SyncClientImpl } from "../src/sync-client/sync-client";
import { createTestLocalChangeStore } from "./helpers/local-change-store";
import {
  atomicMemoryStore,
  clientConfig,
  collection as config,
  fakeDBStorage,
  makeDb,
  tick,
} from "./helpers/storage";

const runtimeStorage = (db: any, store: any) => ({
  resolve: async () => ({ dbAdapter: db, mutations: createLocalMutationSink(db, store) }),
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("collection runtime persists outbox and dirty records before publishing, and delegates reads", async () => {
  const db = makeDb();
  const store = atomicMemoryStore();
  const bus = new ChangeBus<any>();
  const listener = vi.fn();
  bus.subscribe(listener, { stream: "local" });
  const runtime = new CollectionRuntime(config as never, runtimeStorage(db, store), bus);
  await runtime.insert({ id: "1", title: "a" } as never);
  await runtime.update({ id: "1", title: "b" } as never);
  await runtime.delete("1" as never);
  await runtime.get("1" as never);
  await runtime.getMany();
  await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
  const pending = await store.getPendingEvents("todos");
  expect(pending).toHaveLength(3);
  expect(pending).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "create", recordId: "1", data: { id: "1", title: "a" } }),
      expect.objectContaining({ type: "update", recordId: "1" }),
      expect.objectContaining({ type: "delete", recordId: "1", data: { id: "1" } }),
    ]),
  );
  expect((await store.getDirtyRecords("todos"))[0]?.state).toBe("deleted");
  const published = listener.mock.calls.flatMap(([events]) => events as any[]);
  expect(published.map((e) => e.type)).toEqual(["create", "update", "delete"]);
  expect(published.at(-1)).toMatchObject({ id: "1", deletedAt: expect.any(Number) });
  expect(db.insert).toHaveBeenCalledWith("todos", { id: "1", title: "a" });
  expect(db.get).toHaveBeenCalledWith("todos", "1");
  expect(db.getMany).toHaveBeenCalledWith("todos");
});

test("collection runtime commits database mutation before persisting local change state", async () => {
  const order: string[] = [];
  const db = makeDb();
  db.commitLocalMutation = vi.fn(
    async ({ mutate, persistOutboxEvent, persistDirtyRecord }: any) => {
      await db.transaction(async (tx: any) => {
        const context = { operations: tx, native: tx };
        await mutate(context);
        order.push("row-write");
        await persistOutboxEvent(context);
        await persistDirtyRecord(context);
      });
      order.push("db-commit");
    },
  );
  const backingStore = createTestLocalChangeStore();
  const store = {
    ...backingStore,
    atomicLocalMutationCapability: "atomic" as const,
    appendEvents: vi.fn(async (events: any[]) => {
      order.push("outbox");
      await backingStore.appendEvents(events);
    }),
    upsertDirtyRecord: vi.fn(async (record: any) => {
      order.push("dirty");
      await backingStore.upsertDirtyRecord(record);
    }),
  };
  const runtime = new CollectionRuntime(
    config as never,
    runtimeStorage(db, store),
    new ChangeBus<any>(),
  );
  await runtime.insert({ id: "transactional" } as never);
  expect(db.commitLocalMutation).toHaveBeenCalledOnce();
  expect(order).toEqual(["row-write", "outbox", "dirty", "db-commit"]);
  expect(await store.getDirtyRecords("todos")).toMatchObject([
    { recordId: "transactional", state: "dirty" },
  ]);
  db.insert.mockRejectedValueOnce(new Error("db failure"));
  order.length = 0;
  await expect(runtime.insert({ id: "bad" } as never)).rejects.toThrow("db failure");
  expect(order).toEqual([]);
  expect(await store.getPendingEvents("todos")).toHaveLength(1);
});

test("local mutations never fall back to sequential writes", async () => {
  const db = makeDb();
  delete db.commitLocalMutation;
  const store = atomicMemoryStore();
  const runtime = new CollectionRuntime(
    config as never,
    runtimeStorage(db, store),
    new ChangeBus<any>(),
  );

  await expect(runtime.insert({ id: "must-not-write" } as never)).rejects.toThrow(
    "The database adapter must implement atomic local mutations.",
  );
  expect(db.insert).not.toHaveBeenCalled();
  expect(await store.getPendingEvents("todos")).toHaveLength(0);
});

test("retried mutations are recognised by their applied event, even once acknowledged", async () => {
  const db = makeDb();
  const store = atomicMemoryStore();
  const base = { collection: "todos", recordId: "1", createdAt: 1, id: "1" };
  const mutations: LocalMutation[] = [
    { ...base, type: "create", eventId: "e1", data: { id: "1" } },
    { ...base, type: "update", eventId: "e2", data: { id: "1" } },
    { ...base, type: "delete", eventId: "e3" },
  ];
  for (const mutation of mutations) {
    expect(await isLocalMutationCommitted(store, mutation)).toBe(false);
    expect(await executeLocalMutation(db, store, mutation)).toEqual(mutation);
    expect(await isLocalMutationCommitted(store, mutation)).toBe(true);
    // Pushed and acknowledged: the applied record still proves it.
    await store.deleteEvents([mutation.eventId]);
    expect(await isLocalMutationCommitted(store, mutation)).toBe(true);
  }
});

test("sync clients reject adapters without a DB storage or an atomic local-change store", () => {
  const reject = (dbAdapter: unknown) =>
    expect(() => new SyncClientImpl(clientConfig(dbAdapter), new ChangeBus<any>())).toThrow(
      "Sync clients require a database adapter with a DB storage and an atomic local-change store",
    );
  reject(undefined);
  reject({ ...makeDb(), commitLocalMutation: undefined });
  reject({ ...makeDb(), dbStorage: {} });
  reject(makeDb(undefined, createTestLocalChangeStore()));
  reject(makeDb(undefined, { ...atomicMemoryStore(), initialize: undefined }));
});

test("storage failures surface as sync errors", async () => {
  const failure = new Error("open failed");
  const ready = Promise.reject(failure);
  ready.catch(() => undefined);
  const dbStorage = fakeDBStorage({ ready });
  const statuses: Array<{ status: string; error?: unknown }> = [];
  const client = new SyncClientImpl(
    clientConfig(makeDb(undefined, undefined, dbStorage), {
      onSyncStatus: (e: any) => statuses.push(e),
    }),
    new ChangeBus<any>(),
  );
  await tick();
  expect(statuses.at(-1)?.error).toBe(failure);
  const later = new Error("leader failed");
  dbStorage.fail(later);
  expect(statuses.at(-1)?.error).toBe(later);
  await client.dispose();
});

test("sync client supports query subscriptions, checkpoint APIs, status listeners, and disposal", async () => {
  const db = makeDb();
  const statuses: string[] = [];
  const client = new SyncClientImpl(
    clientConfig(db, { onSyncStatus: (e: any) => statuses.push(e.status) }),
    new ChangeBus<any>() as never,
  );
  const statusEvents: string[] = [];
  const unsubStatus = client.subscribeStatus((e) => statusEvents.push(e.status));
  const onData = vi.fn();
  const unsubscribe = client.liveQuery({
    collections: ["todos"],
    query: async () => [1],
    onData,
  } as never);
  await tick();
  expect(onData).toHaveBeenCalledWith([1]);
  expect(await client.getCheckpoint("todos" as never)).toBeUndefined();
  await client.saveCheckpoint("todos" as never, 4 as never);
  client.startSync();
  expect(statuses).toContain("syncing");
  expect(statusEvents[0]).toBe("stopped");
  expect(client.role).toBe("leader");
  unsubscribe();
  unsubStatus();
  await client.dispose();
  expect(statuses.at(-1)).toBe("stopped");
});

test("sync client handles offline state and subscribe overload validation", async () => {
  vi.stubGlobal("navigator", { onLine: false });
  const client = new SyncClientImpl(clientConfig(makeDb()), new ChangeBus<any>() as never);
  const statuses: string[] = [];
  client.subscribeStatus((e) => statuses.push(e.status));
  client.startSync();
  expect(statuses).toContain("offline");
  expect(() => (client.subscribe as (...args: unknown[]) => unknown)()).toThrow(TypeError);
  await client.dispose();
});

test("disposing the client closes its storage", async () => {
  const db = makeDb();
  const client = new SyncClientImpl(clientConfig(db), new ChangeBus<any>());
  await client.dispose();
  expect(db.dbStorage.close).toHaveBeenCalledOnce();
});

test("disposing the client closes its adapter before the storage, even when that fails", async () => {
  const order: string[] = [];
  const db = Object.assign(makeDb(), {
    close: vi.fn(async () => {
      order.push("adapter");
      throw new Error("adapter close failed");
    }),
  });
  vi.mocked(db.dbStorage.close).mockImplementation(async () => {
    order.push("storage");
  });
  const client = new SyncClientImpl(clientConfig(db), new ChangeBus<any>());
  await expect(client.dispose()).rejects.toThrow("adapter close failed");
  expect(order).toEqual(["adapter", "storage"]);
});

test("a commit cut short by a leader change is retried once, without duplicates", async () => {
  const db = makeDb();
  const client = new SyncClientImpl(clientConfig(db), new ChangeBus<any>());
  const commit = db.commitLocalMutation.getMockImplementation();

  // Rolled back before reaching the database: retried.
  db.commitLocalMutation.mockRejectedValueOnce(new LeaderChangedError());
  await client.collections.todos.insert({ id: "1" } as never);
  expect(db.rows.has("1")).toBe(true);
  expect(db.commitLocalMutation).toHaveBeenCalledTimes(2);

  // Committed, but the acknowledgement was lost: not applied twice.
  db.commitLocalMutation.mockClear();
  db.commitLocalMutation.mockImplementationOnce(async (options: any) => {
    await commit(options);
    throw new LeaderChangedError();
  });
  await client.collections.todos.update({ id: "1", title: "b" } as never);
  await client.collections.todos.insert({ id: "2" } as never);
  db.commitLocalMutation.mockClear();
  db.commitLocalMutation.mockImplementationOnce(async (options: any) => {
    await commit(options);
    throw new LeaderChangedError();
  });
  await client.collections.todos.insert({ id: "3" } as never);
  expect(db.commitLocalMutation).toHaveBeenCalledOnce();

  // Other failures and repeated leader changes surface.
  db.commitLocalMutation.mockRejectedValueOnce(new Error("constraint"));
  await expect(client.collections.todos.insert({ id: "4" } as never)).rejects.toThrow("constraint");
  db.commitLocalMutation.mockRejectedValue(new LeaderChangedError());
  await expect(client.collections.todos.insert({ id: "5" } as never)).rejects.toBeInstanceOf(
    LeaderChangedError,
  );
  await client.dispose();
});

test("a retried update or delete never overwrites a newer write made after its push", async () => {
  const db = makeDb();
  const store = db.localChangeStore;
  const client = new SyncClientImpl(clientConfig(db), new ChangeBus<any>());
  const commit = db.commitLocalMutation.getMockImplementation();
  await client.collections.todos.insert({ id: "1", title: "a" } as never);
  await client.collections.todos.insert({ id: "2", title: "a" } as never);

  // The first attempt commits; its event is pushed and acknowledged, another tab writes a
  // newer value, and only then does the leader change surface.
  const committedThenNewerWrite = (newer: () => void) =>
    db.commitLocalMutation.mockImplementationOnce(async (options: any) => {
      await commit(options);
      const pending = await store.getPendingEvents();
      await store.deleteEvents(pending.map((event: { id: string }) => event.id));
      newer();
      throw new LeaderChangedError();
    });
  committedThenNewerWrite(() => db.rows.set("1", { id: "1", title: "newer" }));
  await client.collections.todos.update({ id: "1", title: "stale" } as never);
  committedThenNewerWrite(() => db.rows.set("2", { id: "2", title: "recreated" }));
  await client.collections.todos.delete("2" as never);

  expect(db.rows.get("1")).toMatchObject({ title: "newer" });
  expect(db.rows.get("2")).toMatchObject({ title: "recreated" });
  expect(db.commitLocalMutation).toHaveBeenCalledTimes(4);
  await client.dispose();
});

test("the local-change store is initialized before anything touches the database", async () => {
  let finish!: () => void;
  const store = atomicMemoryStore();
  store.initialize.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
  const db = makeDb(undefined, store);
  const client = new SyncClientImpl(clientConfig(db), new ChangeBus<any>());
  const onData = vi.fn();
  client.liveQuery({ query: async () => "rows", onData } as never);
  const insert = client.collections.todos.insert({ id: "1" } as never);
  (db.dbStorage as any).setRole("follower");
  await tick();
  expect(store.initialize).toHaveBeenCalledOnce();
  expect(db.commitLocalMutation).not.toHaveBeenCalled();
  expect(onData).not.toHaveBeenCalled();
  expect(client.role).toBe("follower");

  finish();
  await insert;
  await tick();
  expect(onData).toHaveBeenCalledWith("rows");
  // The role at the end of initialization is applied.
  expect(client.role).toBe("follower");
  await client.dispose();
});

test("a failing local-change store initialization surfaces as a sync error", async () => {
  const store = atomicMemoryStore();
  store.initialize.mockRejectedValue(new Error("no tables"));
  const statuses: Array<{ status: string; error?: unknown }> = [];
  const client = new SyncClientImpl(
    clientConfig(makeDb(undefined, store), { onSyncStatus: (e: any) => statuses.push(e) }),
    new ChangeBus<any>(),
  );
  await expect(client.collections.todos.insert({ id: "1" } as never)).rejects.toThrow("no tables");
  expect(statuses.at(-1)?.error).toEqual(new Error("no tables"));
  await client.dispose();
});

test("collection runtime rejects primary key values that are not a string or number", async () => {
  const db = makeDb();
  const store = atomicMemoryStore();
  const runtime = new CollectionRuntime(
    config as never,
    runtimeStorage(db, store),
    new ChangeBus(),
  );
  await expect(runtime.insert({ id: { a: 1, b: 2 }, title: "a" } as never)).rejects.toThrow(
    "Composite primary keys are not supported",
  );
  await expect(runtime.update({ title: "no id" } as never)).rejects.toThrow(
    'needs a string or number value in its primary field "id", got undefined',
  );
  await expect(runtime.delete({ a: 1 } as never)).rejects.toThrow(TypeError);
  await expect(runtime.delete(null as never)).rejects.toThrow("got null");
  await runtime.insert({ id: 7, title: "numeric" } as never);
  expect(db.commitLocalMutation).toHaveBeenCalledOnce();
  expect((await store.getPendingEvents())[0]).toMatchObject({ recordId: "7" });
  await runtime.delete("123" as never);
  expect((await store.getPendingEvents())[1]).toMatchObject({
    recordId: "123",
    data: { id: "123" },
  });
});

test("writes to collections no sync adapter handles stay out of the outbox", async () => {
  const synced = { name: "todos", adapterConfig: {}, primaryField: "id" };
  const local = { name: "drafts", adapterConfig: {}, primaryField: "id" };
  const own = {
    name: "notes",
    adapterConfig: {},
    primaryField: "id",
    syncAdapter: { pull: vi.fn(), push: vi.fn() },
  };
  const db = makeDb();
  const bus = new ChangeBus<any>();
  const published: any[] = [];
  bus.subscribe((events) => published.push(...events), { stream: "local" });
  const client = new SyncClientImpl(
    clientConfig(db, {
      collections: [synced, local, own],
      syncAdapter: { collections: ["todos"], pull: vi.fn(), push: vi.fn() },
    }),
    bus,
  );
  await client.collections.todos.insert({ id: "1" } as never);
  await client.collections.drafts.insert({ id: "2" } as never);
  await client.collections.drafts.delete("2" as never);
  await client.collections.notes.insert({ id: "3" } as never);
  const pending = await db.localChangeStore.getPendingEvents();
  expect(pending.map((event: any) => event.collection)).toEqual(["todos", "notes"]);
  expect(await db.localChangeStore.getDirtyRecords("drafts")).toEqual([]);
  // Still recorded as applied, so a retried local-only write is not applied twice.
  const draft = published.find((event) => event.collection === "drafts");
  expect(await db.localChangeStore.hasAppliedEvent(draft.eventId)).toBe(true);
  await client.dispose();

  // Without any sync adapter every collection is local only.
  const bare = makeDb();
  const offline = new SyncClientImpl(clientConfig(bare), new ChangeBus<any>());
  await offline.collections.todos.insert({ id: "1" } as never);
  expect(await bare.localChangeStore.getPendingEvents()).toEqual([]);
  await offline.dispose();
});

test("a collection cannot be synced by both its own and the client-level adapter", () => {
  const own = { ...config, syncAdapter: { pull: vi.fn(), push: vi.fn() } };
  expect(
    () =>
      new SyncClientImpl(
        clientConfig(makeDb(), {
          collections: [own],
          syncAdapter: { collections: ["todos"], pull: vi.fn(), push: vi.fn() },
        }),
        new ChangeBus<any>(),
      ),
  ).toThrow('Collection "todos" has its own syncAdapter and is also synced');
});
