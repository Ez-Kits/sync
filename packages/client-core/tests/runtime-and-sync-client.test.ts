import { afterEach, expect, test, vi } from "vite-plus/test";
import { ChangeBus } from "../src/change-bus";
import {
  createLocalMutationSink,
  isLocalMutationCommitted,
  type LocalMutation,
} from "../src/collection/local-mutation";
import { CollectionRuntime } from "../src/collection/runtime";
import { createCoordinatedStorage } from "../src/storage-coordination";
import { CoordinatedStorage } from "../src/storage-coordination/coordinated-storage";
import { SyncClientImpl } from "../src/sync-client/sync-client";
import { AtomicLocalMutationStorage } from "../src/sync-client/storage-pair";
import { createTestLocalChangeStore } from "./helpers/local-change-store";
import {
  atomicMemoryStore,
  clientConfig,
  collection as config,
  makeDb,
  standaloneStorage,
  tick,
} from "./helpers/storage";

const runtimeStorage = (db: any, store: any) => ({
  resolve: async () => ({ dbAdapter: db, mutations: createLocalMutationSink(db, store) }),
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("atomic storage pairs reject creation without the storage factory token", () => {
  expect(() =>
    AtomicLocalMutationStorage.create(makeDb() as never, atomicMemoryStore(), Symbol() as never),
  ).toThrow("Atomic storage pairs must be created by a storage factory");
});

test("coordinated storage rejects creation without the factory token", () => {
  expect(() => CoordinatedStorage.create({} as never, Symbol() as never)).toThrow(
    "Coordinated storage must be created by createCoordinatedStorage",
  );
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
      expect.objectContaining({ type: "delete", recordId: "1", data: null }),
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

test("retried mutations are recognised by their outbox event or an existing created row", async () => {
  const db = makeDb();
  const store = atomicMemoryStore();
  const base = { collection: "todos", recordId: "1", createdAt: 1, id: "1" };
  const create: LocalMutation = { ...base, type: "create", eventId: "e1", data: { id: "1" } };
  expect(await isLocalMutationCommitted(db, store, create)).toBe(false);
  await createLocalMutationSink(db, store).commit(create);
  expect(await isLocalMutationCommitted(db, store, create)).toBe(true);
  await store.deleteEvents(["e1"]);
  // Committed and already pushed: the row proves it.
  expect(await isLocalMutationCommitted(db, store, create)).toBe(true);
  const update: LocalMutation = { ...base, type: "update", eventId: "e2", data: { id: "1" } };
  expect(await isLocalMutationCommitted(db, store, update)).toBe(false);

  const withOptional = { ...db, getOptional: vi.fn(async () => undefined) };
  expect(await isLocalMutationCommitted(withOptional, store, create)).toBe(false);
  const throwingGet = { ...db, get: vi.fn(async () => Promise.reject(new Error("missing"))) };
  expect(await isLocalMutationCommitted(throwingGet, store, create)).toBe(false);
});

test("sync clients reject storage not built by createCoordinatedStorage", () => {
  const forged = { dbAdapter: makeDb(), localChangeStore: atomicMemoryStore() };
  expect(() => new SyncClientImpl(clientConfig(forged), new ChangeBus<any>())).toThrow(
    "Sync clients require storage created by createCoordinatedStorage",
  );
  expect(() => new SyncClientImpl(clientConfig(undefined), new ChangeBus<any>())).toThrow(
    "createCoordinatedStorage",
  );
});

test("storage rejects stores without an atomic mutation capability", async () => {
  const storage = standaloneStorage(makeDb(), createTestLocalChangeStore());
  const statuses: string[] = [];
  const client = new SyncClientImpl(
    clientConfig(storage, { onSyncStatus: (e: any) => statuses.push(e.status) }),
    new ChangeBus<any>(),
  );
  await expect(storage.ready).rejects.toThrow("paired database adapter and local-change store");
  await tick();
  expect(statuses).toContain("error");
  await client.dispose();
});

test("sync client supports query subscriptions, checkpoint APIs, status listeners, and disposal", async () => {
  const db = makeDb();
  const statuses: string[] = [];
  const client = new SyncClientImpl(
    clientConfig(standaloneStorage(db), { onSyncStatus: (e: any) => statuses.push(e.status) }),
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
  expect(client.storageRole).toBe("owner");
  unsubscribe();
  unsubStatus();
  await client.dispose();
  expect(statuses.at(-1)).toBe("stopped");
});

test("sync client handles offline state and subscribe overload validation", async () => {
  vi.stubGlobal("navigator", { onLine: false });
  const client = new SyncClientImpl(
    clientConfig(standaloneStorage()),
    new ChangeBus<any>() as never,
  );
  const statuses: string[] = [];
  client.subscribeStatus((e) => statuses.push(e.status));
  client.startSync();
  expect(statuses).toContain("offline");
  expect(() => (client.subscribe as (...args: unknown[]) => unknown)()).toThrow(TypeError);
  await client.dispose();
});

test("disposed storage rejects further use, and dispose is idempotent", async () => {
  const close = vi.fn(async () => {});
  const storage = createCoordinatedStorage({
    sharing: "shared",
    coordinateTabs: false,
    open: () => ({ database: makeDb(), close }),
    createDBAdapter: (database: any) => database,
    createLocalChangeStore: () => atomicMemoryStore(),
  });
  await storage.ready;
  const client = new SyncClientImpl(clientConfig(storage), new ChangeBus<any>());
  await client.dispose();
  await storage.dispose();
  expect(close).toHaveBeenCalledOnce();
  await expect(client.collections.todos.getMany()).rejects.toThrow("disposed");
});
