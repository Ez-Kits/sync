import { afterEach, expect, test, vi } from "vite-plus/test";
import { ChangeBus } from "../src/change-bus";
import { CollectionRuntime } from "../src/collection/runtime";
import { SyncClientImpl } from "../src/sync-client/sync-client";
import {
  AtomicLocalMutationStorage,
  createAtomicLocalMutationStorage,
} from "../src/sync-client/storage-pair";
import { createTestLocalChangeStore } from "./helpers/local-change-store";

type Config = { name: "todos"; adapterConfig: {}; primaryField: "id" };
const config: Config = { name: "todos", adapterConfig: {}, primaryField: "id" };
const createAtomicMemoryStore = () => ({
  ...createTestLocalChangeStore(),
  atomicLocalMutationCapability: "atomic" as const,
});
const pairStorage = (db: any, store = createAtomicMemoryStore()) =>
  createAtomicLocalMutationStorage(
    db,
    (database) => database,
    () => store,
  );
const makeDb = () => {
  const rows = new Map<string, { id: string; title?: string }>();
  const db = {
    queryBuilder: {},
    querySchema: { todos: {} },
    insert: vi.fn(async (_n: string, row: { id: string; title?: string }) => {
      rows.set(row.id, row);
    }),
    update: vi.fn(async (_n: string, row: { id: string; title?: string }) => {
      rows.set(row.id, row);
    }),
    delete: vi.fn(async (_n: string, id: string) => {
      rows.delete(id);
    }),
    get: vi.fn(async (_n: string, id: string) => rows.get(id)),
    getMany: vi.fn(async () => [...rows.values()]),
    transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(db)),
    commitLocalMutation: vi.fn(async ({ mutate, persistOutboxEvent, persistDirtyRecord }: any) => {
      const context = { operations: db, native: db };
      await mutate(context);
      await persistOutboxEvent(context);
      await persistDirtyRecord(context);
    }),
  };
  return db;
};

afterEach(() => vi.restoreAllMocks());

test("atomic storage pairs reject creation without the storage factory token", () => {
  expect(() =>
    AtomicLocalMutationStorage.create(
      makeDb() as never,
      createAtomicMemoryStore(),
      Symbol() as never,
    ),
  ).toThrow("Atomic storage pairs must be created by a storage factory");
});

test("collection runtime persists outbox and dirty records before publishing, and delegates reads", async () => {
  const db = makeDb();
  const store = createAtomicMemoryStore();
  const bus = new ChangeBus<any>();
  const listener = vi.fn();
  bus.subscribe(listener, { stream: "local" });
  const runtime = new CollectionRuntime(config as never, db as never, bus, store);
  await runtime.insert({ id: "1", title: "a" } as never);
  await runtime.update({ id: "1", title: "b" } as never);
  await runtime.delete("1" as never);
  await runtime.get("1" as never);
  await runtime.getMany();
  await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
  expect(await store.getPendingEvents("todos")).toHaveLength(3);
  expect((await store.getDirtyRecords("todos"))[0]?.state).toBe("deleted");
  expect(listener.mock.calls.flatMap(([events]) => (events as any[]).map((e) => e.type))).toEqual([
    "create",
    "update",
    "delete",
  ]);
  expect(db.insert).toHaveBeenCalledWith("todos", { id: "1", title: "a" });
  expect(db.get).toHaveBeenCalledWith("todos", "1");
  expect(db.getMany).toHaveBeenCalledWith("todos");
});

test("collection runtime commits database mutation before persisting local change state", async () => {
  const order: string[] = [];
  const db = makeDb() as ReturnType<typeof makeDb> & {
    commitLocalMutation: ReturnType<typeof vi.fn>;
  };
  db.commitLocalMutation = vi.fn(
    async ({ mutate, persistOutboxEvent, persistDirtyRecord }: any) => {
      await db.transaction(async (tx) => {
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
  const runtime = new CollectionRuntime(config as never, db as never, new ChangeBus<any>(), store);
  await runtime.insert({ id: "transactional" } as never);
  expect(db.commitLocalMutation).toHaveBeenCalledOnce();
  expect(order).toEqual(["row-write", "outbox", "dirty", "db-commit"]);
  expect(await store.getPendingEvents("todos")).toHaveLength(1);
  expect(await store.getDirtyRecords("todos")).toMatchObject([
    { recordId: "transactional", state: "dirty" },
  ]);
  db.insert.mockRejectedValueOnce(new Error("db failure"));
  order.length = 0;
  await expect(runtime.insert({ id: "bad" } as never)).rejects.toThrow("db failure");
  expect(order).toEqual([]);
  expect(await store.getPendingEvents("todos")).toHaveLength(1);
  expect(await store.getDirtyRecords("todos")).toHaveLength(1);
});

test("sync clients reject stores without an atomic mutation capability", () => {
  const db = makeDb();
  const store = createTestLocalChangeStore();
  const storage = pairStorage(db, store as never);
  expect(
    () =>
      new SyncClientImpl(
        {
          collections: [config],
          storage,
          checkpointStorage: {
            getCheckpoint: vi.fn(async () => undefined),
            saveCheckpoint: vi.fn(async () => {}),
          },
        } as never,
        new ChangeBus<any>(),
      ),
  ).toThrow("paired database adapter and local-change store");
});

test("local mutations never fall back to sequential writes", async () => {
  const db = makeDb();
  delete (db as any).commitLocalMutation;
  const store = createAtomicMemoryStore();
  const runtime = new CollectionRuntime(config as never, db as never, new ChangeBus<any>(), store);

  await expect(runtime.insert({ id: "must-not-write" } as never)).rejects.toThrow(
    "The database adapter must implement atomic local mutations.",
  );
  expect(db.insert).not.toHaveBeenCalled();
  expect(await store.getPendingEvents("todos")).toHaveLength(0);
  expect(await store.getDirtyRecords("todos")).toHaveLength(0);
});

test("sync client supports query subscriptions, checkpoint APIs, status listeners, and disposal", async () => {
  const db = makeDb();
  const statuses: string[] = [];
  const client = new SyncClientImpl(
    {
      collections: [config],
      storage: pairStorage(db),
      checkpointStorage: {
        getCheckpoint: vi.fn(async () => undefined),
        saveCheckpoint: vi.fn(async () => {}),
      },
      coordinateTabs: false,
      onSyncStatus: (e: any) => statuses.push(e.status),
    } as never,
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
  await Promise.resolve();
  expect(onData).toHaveBeenCalledWith([1]);
  expect(await client.getCheckpoint("todos" as never)).toBeUndefined();
  await client.saveCheckpoint("todos" as never, 4 as never);
  client.startSync();
  expect(statuses).toContain("syncing");
  expect(statusEvents[0]).toBe("stopped");
  unsubscribe();
  unsubStatus();
  client.dispose();
  expect(statuses.at(-1)).toBe("stopped");
});

test("sync client handles offline state and subscribe overload validation", () => {
  const db = makeDb();
  const prior = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: false } });
  try {
    const client = new SyncClientImpl(
      {
        collections: [config],
        storage: pairStorage(db),
        checkpointStorage: {
          getCheckpoint: vi.fn(async () => undefined),
          saveCheckpoint: vi.fn(async () => {}),
        },
      } as never,
      new ChangeBus<any>() as never,
    );
    const statuses: string[] = [];
    client.subscribeStatus((e) => statuses.push(e.status));
    client.startSync();
    expect(statuses).toContain("offline");
    expect(() => (client.subscribe as (...args: unknown[]) => unknown)()).toThrow(TypeError);
    client.dispose();
  } finally {
    if (prior) Object.defineProperty(globalThis, "navigator", prior);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});
