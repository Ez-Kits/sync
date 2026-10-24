import { afterEach, expect, test, vi } from "vite-plus/test";
import "fake-indexeddb/auto";
import { ChangeBus } from "../src/change-bus";
import { ChangeBusStreamChannel } from "../src/change-bus/change-bus-stream-channel";
import { createLocalStorageCheckpointStorage } from "../src/checkpoint-storage/local-storage";
import { createIndexedDBLocalChangeStore } from "../src/local-change-store/indexed-db";
import { createMemoryLocalChangeStore } from "../src/local-change-store/memory";

type Event = { todos: { create: { id: string }; update: { id: string }; delete: string } };
const event = (id: string, collection = "todos", createdAt = 1) => ({
  id,
  type: "create" as const,
  collection,
  data: { id },
  recordId: id,
  createdAt,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("memory store filters, orders, overwrites, and removes events and dirty records", async () => {
  const store = createMemoryLocalChangeStore();
  await store.appendEvents([]);
  await store.appendEvents([event("b", "todos", 2), event("a"), event("other", "users")]);
  await store.appendEvents([{ ...event("a", "todos", 3), data: { id: "updated" } }]);
  expect((await store.getPendingEvents("todos")).map((e) => e.id)).toEqual(["b", "a"]);
  expect((await store.getPendingEvents())[2]?.data).toEqual({ id: "updated" });
  await store.deleteEvents(["b", "missing"]);
  expect((await store.getPendingEvents("todos")).map((e) => e.id)).toEqual(["a"]);
  await store.upsertDirtyRecord({
    collection: "todos",
    recordId: "1",
    state: "dirty",
    updatedAt: 1,
  });
  await store.upsertDirtyRecord({
    collection: "users",
    recordId: "1",
    state: "deleted",
    updatedAt: 2,
  });
  expect((await store.getDirtyRecords("todos")).map((r) => r.state)).toEqual(["dirty"]);
  await store.removeDirtyRecords([{ collection: "todos", recordId: "1" }]);
  expect(await store.getDirtyRecords("todos")).toEqual([]);
});

test("memory lease enforces owner, expiry, renewal, and fencing tokens", async () => {
  const store = createMemoryLocalChangeStore();
  expect(await store.acquireLease!("app", "a", 0, 50)).toBe(1);
  expect(await store.acquireLease!("app", "a", 1, 50)).toBe(1);
  expect(await store.acquireLease!("app", "b", 2, 50)).toBeUndefined();
  await store.releaseLease!("app", "b", 1);
  expect(await store.acquireLease!("app", "a", 2, 50)).toBe(1);
  expect(await store.acquireLease!("app", "b", 52, 50)).toBe(2);
  await store.releaseLease!("app", "b", 1);
  expect(await store.acquireLease!("app", "a", 53, 50)).toBeUndefined();
  await store.releaseLease!("app", "b", 2);
  expect(await store.acquireLease!("app", "a", 54, 50)).toBe(3);
});

test("IndexedDB store persists events, dirty records, and leases and handles empty batches", async () => {
  const dbName = `test-${crypto.randomUUID()}`;
  const store = createIndexedDBLocalChangeStore({ dbName });
  await store.getPendingEvents();
  await createIndexedDBLocalChangeStore({ dbName }).getPendingEvents();
  await store.appendEvents([]);
  await store.appendEvents([event("2", "todos", 2), event("1"), event("u", "users")]);
  expect((await store.getPendingEvents("todos")).map((e) => e.id)).toEqual(["1", "2"]);
  expect((await store.getPendingEvents()).length).toBe(3);
  await store.deleteEvents([]);
  await store.deleteEvents(["2"]);
  expect((await store.getPendingEvents("todos")).map((e) => e.id)).toEqual(["1"]);
  await store.upsertDirtyRecord({
    collection: "todos",
    recordId: "1",
    state: "dirty",
    updatedAt: 1,
  });
  await store.upsertDirtyRecord({
    collection: "users",
    recordId: "1",
    state: "deleted",
    updatedAt: 2,
  });
  expect((await store.getDirtyRecords("todos")).length).toBe(1);
  expect((await store.getDirtyRecords()).length).toBe(2);
  await store.removeDirtyRecords([]);
  await store.removeDirtyRecords([{ collection: "todos", recordId: "1" }]);
  expect(await store.getDirtyRecords("todos")).toEqual([]);
  expect(await store.acquireLease!("sync", "one", 0, 20)).toBe(1);
  expect(await store.acquireLease!("sync", "one", 1, 20)).toBe(1);
  expect(await store.acquireLease!("sync", "two", 2, 20)).toBeUndefined();
  expect(await store.acquireLease!("sync", "two", 21, 20)).toBe(2);
  await store.releaseLease!("sync", "one", 1);
  expect(await store.acquireLease!("sync", "one", 22, 20)).toBeUndefined();
  await store.releaseLease!("sync", "two", 2);
  expect(await store.acquireLease!("sync", "one", 23, 20)).toBe(3);
});

test("IndexedDB upgrade leaves existing version-one stores intact", async () => {
  const dbName = `upgrade-${crypto.randomUUID()}`;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      const events = request.result.createObjectStore("change_events", { keyPath: "id" });
      events.createIndex("by_collection", "collection", { unique: false });
      const dirty = request.result.createObjectStore("dirty_records", {
        keyPath: ["collection", "recordId"],
      });
      dirty.createIndex("by_collection", "collection", { unique: false });
      request.result.createObjectStore("sync_leases", { keyPath: "key" });
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
  expect(await createIndexedDBLocalChangeStore({ dbName }).getPendingEvents()).toEqual([]);
});

test("IndexedDB requests reject on database open failure", async () => {
  const original = indexedDB.open.bind(indexedDB);
  vi.spyOn(indexedDB, "open").mockImplementationOnce(((
    ...args: Parameters<typeof indexedDB.open>
  ) => {
    const request = original(...args);
    queueMicrotask(() => {
      Object.defineProperty(request, "error", {
        configurable: true,
        value: new DOMException("blocked"),
      });
      request.onerror?.(new globalThis.Event("error") as never);
    });
    return request;
  }) as typeof indexedDB.open);
  await expect(
    createIndexedDBLocalChangeStore({ dbName: "bad-open" }).getPendingEvents(),
  ).rejects.toBeTruthy();
});

test("IndexedDB open failures without an error object use the fallback error", async () => {
  vi.spyOn(indexedDB, "open").mockImplementationOnce((() => {
    const request: any = { error: null };
    queueMicrotask(() => request.onerror?.(new globalThis.Event("error")));
    return request;
  }) as typeof indexedDB.open);
  await expect(
    createIndexedDBLocalChangeStore({ dbName: "fallback-open" }).getPendingEvents(),
  ).rejects.toThrow("Failed to open IndexedDB");
});

test("IndexedDB rejects failed object-store requests and aborted transactions", async () => {
  const dbName = `request-${crypto.randomUUID()}`;
  const originalGetAll = (IDBObjectStore.prototype as any)
    .getAll as typeof IDBObjectStore.prototype.getAll;
  vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore["getAll"]>
  ) {
    originalGetAll.call(this, ...args);
    const request = {
      onsuccess: null as ((event: globalThis.Event) => void) | null,
      onerror: null as ((event: globalThis.Event) => void) | null,
      error: null,
    };
    queueMicrotask(() => request.onerror?.(new globalThis.Event("error")));
    return request as unknown as IDBRequest<unknown[]>;
  });
  await expect(createIndexedDBLocalChangeStore({ dbName }).getPendingEvents()).rejects.toThrow(
    "IndexedDB request failed",
  );
  vi.restoreAllMocks();

  const originalTransaction = (IDBDatabase.prototype as any)
    .transaction as typeof IDBDatabase.prototype.transaction;
  vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase["transaction"]>
  ) {
    const tx = originalTransaction.apply(this, args);
    queueMicrotask(() => tx.abort());
    return tx;
  });
  await expect(
    createIndexedDBLocalChangeStore({ dbName: `abort-${crypto.randomUUID()}` }).appendEvents([
      event("x"),
    ]),
  ).rejects.toThrow();
  vi.restoreAllMocks();
  vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
    this: IDBDatabase,
    ...args: Parameters<IDBDatabase["transaction"]>
  ) {
    const tx = originalTransaction.apply(this, args);
    queueMicrotask(() => {
      Object.defineProperty(tx, "error", { configurable: true, value: null });
      tx.onerror?.(new globalThis.Event("error") as never);
    });
    return tx;
  });
  await expect(
    createIndexedDBLocalChangeStore({ dbName: `error-${crypto.randomUUID()}` }).appendEvents([
      event("x"),
    ]),
  ).rejects.toThrow("IndexedDB transaction failed");

  vi.restoreAllMocks();
  const base = createIndexedDBLocalChangeStore({ dbName: `abort-handler-${crypto.randomUUID()}` });
  await base.getPendingEvents();
  const fakeTx: any = {
    error: null,
    objectStore: () => ({ put: vi.fn() }),
    oncomplete: null,
    onerror: null,
    onabort: null,
  };
  vi.spyOn(IDBDatabase.prototype, "transaction").mockReturnValue(fakeTx);
  const aborting = base.appendEvents([event("abort-handler")]);
  queueMicrotask(() => fakeTx.onabort?.(new globalThis.Event("abort")));
  await expect(aborting).rejects.toThrow("IndexedDB transaction aborted");
});

test("checkpoint storage serializes per collection, deserializes, and removes empty serialization", async () => {
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  });
  const storage = createLocalStorageCheckpointStorage<string, number>({
    key: "sync",
    serializer: (n) => (n > 0 ? String(n) : undefined),
    deserializer: (raw) => Number(raw),
  });
  expect(await storage.getCheckpoint("todos")).toBeUndefined();
  await storage.saveCheckpoint("todos", 8);
  await storage.saveCheckpoint("users", 4);
  expect(await storage.getCheckpoint("todos")).toBe(8);
  expect(await storage.getCheckpoint("users")).toBe(4);
  await storage.saveCheckpoint("todos", 0);
  expect(await storage.getCheckpoint("todos")).toBeUndefined();
});

test("change bus batches, filters collections and streams, deduplicates subscriptions, and unsubscribes", async () => {
  const bus = new ChangeBus<Event>();
  const local = vi.fn();
  const remote = vi.fn();
  const all = vi.fn();
  const stop = bus.subscribe(["todos"], local, { stream: "local" });
  bus.subscribe(remote, { stream: "remote" });
  bus.subscribe(all);
  bus.publishLocalBatch([
    { type: "create", collection: "todos", data: { id: "1" } },
    { type: "create", collection: "users", data: { id: "2" } },
  ] as never);
  bus.publishLocal({ type: "update", collection: "todos", data: { id: "same-turn" } } as never);
  bus.publishRemote({ type: "delete", collection: "todos", id: "3" } as never);
  bus.publishLocal({ type: "update", collection: "users", data: { id: "filtered" } } as never);
  await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
  expect(local).toHaveBeenCalledTimes(1);
  expect(local.mock.calls[0]?.[0]).toHaveLength(2);
  expect(remote).toHaveBeenCalledTimes(1);
  expect(all).toHaveBeenCalledTimes(2);
  bus.publishLocal({ type: "update", collection: "users", data: { id: "filtered-only" } } as never);
  await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
  expect(local).toHaveBeenCalledOnce();
  stop();
  bus.publishLocal({ type: "update", collection: "todos", data: { id: "1" } } as never);
  await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
  expect(local).toHaveBeenCalledTimes(1);
});

test("change bus rejects invalid scoped subscribe arguments", () => {
  const bus = new ChangeBus<Event>();
  expect(() => (bus.subscribe as (...args: unknown[]) => unknown)("todos", undefined)).toThrow(
    TypeError,
  );
});

test("stream channel deduplicates events and its returned unsubscribe is idempotent", async () => {
  const channel = new ChangeBusStreamChannel<Event>();
  const listener = vi.fn();
  const unsubscribe = channel.subscribe(listener);
  const update = { type: "update", collection: "todos", data: { id: "1" } } as never;
  channel.publish(update);
  channel.publish(update);
  await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
  unsubscribe();
  channel.publish(update);
  await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
  expect(listener).toHaveBeenCalledOnce();
});
