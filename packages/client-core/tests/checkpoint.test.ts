import { afterEach, expect, test, vi } from "vite-plus/test";
import * as publicAPI from "../src";
import { createCheckpointStorage } from "../src/checkpoint-storage";
import { createSyncClient } from "../src/sync-client";
import { createTestLocalChangeStore } from "./helpers/local-change-store";
import {
  atomicMemoryStore,
  clientConfig,
  collection,
  fakeDBStorage,
  makeDb,
  settle,
  tick,
} from "./helpers/storage";

/** A checkpoint that is not plain JSON, like a Firestore `Timestamp`. */
class Stamp {
  constructor(readonly millis: number) {}
}
const stampCheckpoint = {
  serialize: (stamp: Stamp) => String(stamp.millis),
  deserialize: (value: string) => new Stamp(Number(value)),
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** A collection adapter whose pull streams the test drives. */
function pullAdapter() {
  const streams: any[] = [];
  return {
    streams,
    push: vi.fn(async ({ events, commitChanges }: any) => commitChanges({ events })),
    pull: vi.fn((options: any) => {
      streams.push(options);
      return () => {};
    }),
  };
}

/** An adapter whose transactions hand `native` to the store, as real adapters do. */
function transactionalDb(store = atomicMemoryStore()) {
  const db = makeDb(undefined, store);
  const native = { transaction: "pull" };
  db.transaction.mockImplementation(async (fn: (tx: any, context: any) => Promise<unknown>) =>
    fn(db, { operations: db, native }),
  );
  return { db, store, native };
}

test("checkpoint storage is no longer part of the public API", () => {
  for (const name of [
    "createLocalStorageCheckpointStorage",
    "createDBCheckpointStorage",
    "isTransactionalCheckpointStorage",
    "createCheckpointStorage",
  ]) {
    expect(publicAPI).not.toHaveProperty(name);
  }
});

test("the internal storage keeps JSON checkpoints in the local-change store by default", async () => {
  const store = createTestLocalChangeStore();
  const save = vi.spyOn(store, "saveCheckpoint");
  const storage = createCheckpointStorage<string, { cursor: string; at: number }>(store);
  expect(await storage.getCheckpoint("todos")).toBeUndefined();
  const native = { transaction: "pull" };
  await storage.saveCheckpoint("todos", { cursor: "c", at: 1 }, native);
  expect(save).toHaveBeenCalledExactlyOnceWith("todos", '{"cursor":"c","at":1}', native);
  expect(await storage.getCheckpoint("todos", native)).toEqual({ cursor: "c", at: 1 });
  // `undefined` removes it.
  await storage.saveCheckpoint("todos", undefined);
  expect(await store.getCheckpoint("todos")).toBeUndefined();
});

test("the client stores checkpoints as JSON in its adapter's store by default", async () => {
  const db = makeDb();
  const client = createSyncClient(clientConfig(db));
  expect(await client.getCheckpoint("todos")).toBeUndefined();
  await client.saveCheckpoint("todos", { cursor: "c1", page: 2 });
  expect(await db.localChangeStore.getCheckpoint("todos")).toBe('{"cursor":"c1","page":2}');
  expect(await client.getCheckpoint("todos")).toEqual({ cursor: "c1", page: 2 });
  // Saving no checkpoint resets the collection: its next pull starts from scratch.
  await client.saveCheckpoint("todos", undefined);
  expect(await db.localChangeStore.getCheckpoint("todos")).toBeUndefined();
  expect(await client.getCheckpoint("todos")).toBeUndefined();
  await client.dispose();
});

test("the client round-trips checkpoints JSON cannot hold through the configured serializer", async () => {
  const db = makeDb();
  const client = createSyncClient(clientConfig(db, { checkpointSerializer: stampCheckpoint }));
  await client.saveCheckpoint("todos", new Stamp(42));
  expect(await db.localChangeStore.getCheckpoint("todos")).toBe("42");
  const read = await client.getCheckpoint("todos");
  expect(read).toBeInstanceOf(Stamp);
  expect(read).toEqual(new Stamp(42));
  await client.dispose();
});

test("the adapter that syncs a collection serializes its checkpoints, unless the client sets one", async () => {
  const db = makeDb();
  const prefixed = (prefix: string) => ({
    serialize: (stamp: Stamp) => `${prefix}:${stamp.millis}`,
    deserialize: (value: string) => new Stamp(Number(value.split(":")[1])),
  });
  const notes = {
    name: "notes",
    adapterConfig: {},
    primaryField: "id",
    syncAdapter: { ...pullAdapter(), checkpointSerializer: prefixed("own") },
  };
  const drafts = { name: "drafts", adapterConfig: {}, primaryField: "id" };
  const config = {
    collections: [collection, notes, drafts],
    syncAdapter: { ...pullAdapter(), checkpointSerializer: prefixed("client") },
  };
  const client = createSyncClient(clientConfig(db, config));
  await client.saveCheckpoint("todos", new Stamp(1));
  await client.saveCheckpoint("notes", new Stamp(2));
  expect(await db.localChangeStore.getCheckpoint("todos")).toBe("client:1");
  expect(await db.localChangeStore.getCheckpoint("notes")).toBe("own:2");
  expect(await client.getCheckpoint("notes")).toEqual(new Stamp(2));
  await client.dispose();

  const overridden = createSyncClient(
    clientConfig(db, { ...config, checkpointSerializer: stampCheckpoint }),
  );
  await overridden.saveCheckpoint("notes", new Stamp(3));
  expect(await db.localChangeStore.getCheckpoint("notes")).toBe("3");
  await overridden.dispose();
});

test("checkpoint calls before initialization wait for the storage and the store", async () => {
  let ready!: () => void;
  const store = atomicMemoryStore();
  const db = makeDb(
    undefined,
    store,
    fakeDBStorage({ ready: new Promise<void>((resolve) => (ready = resolve)) }),
  );
  const getCheckpoint = vi.spyOn(store, "getCheckpoint");
  const saveCheckpoint = vi.spyOn(store, "saveCheckpoint");
  const client = createSyncClient(clientConfig(db));
  const saved = client.saveCheckpoint("todos", "c1");
  const read = saved.then(() => client.getCheckpoint("todos"));
  await settle();
  expect(store.initialize).not.toHaveBeenCalled();
  expect(saveCheckpoint).not.toHaveBeenCalled();
  expect(getCheckpoint).not.toHaveBeenCalled();
  ready();
  await saved;
  expect(await read).toBe("c1");
  expect(store.initialize.mock.invocationCallOrder[0]!).toBeLessThan(
    saveCheckpoint.mock.invocationCallOrder[0]!,
  );
  await client.dispose();
});

test("a checkpoint call fails when the storage cannot initialize", async () => {
  const failure = new Error("storage unavailable");
  const store = atomicMemoryStore();
  store.initialize.mockRejectedValue(failure);
  const client = createSyncClient(clientConfig(makeDb(undefined, store)));
  await expect(client.getCheckpoint("todos")).rejects.toBe(failure);
  await expect(client.saveCheckpoint("todos", "c1")).rejects.toBe(failure);
  await client.dispose();
});

test("a pulled checkpoint is serialized into the adapter's store inside the pull transaction", async () => {
  const { db, store, native } = transactionalDb();
  const save = vi.spyOn(store, "saveCheckpoint");
  const adapter = pullAdapter();
  const config = clientConfig(db, {
    collections: [{ ...collection, syncAdapter: adapter }],
    checkpointSerializer: stampCheckpoint,
  });
  const client = createSyncClient(config);
  client.startSync();
  await vi.waitFor(() => expect(adapter.streams).toHaveLength(1));
  expect(adapter.streams[0].checkpoint).toBeUndefined();
  adapter.streams[0].commitChanges({
    changes: [{ type: "create", collection: "todos", data: { id: "1" } }],
    checkpoint: { todos: new Stamp(5) },
  });
  await vi.waitFor(async () => expect(await store.getCheckpoint("todos")).toBe("5"));
  expect(save).toHaveBeenCalledExactlyOnceWith("todos", "5", native);
  expect(db.transaction).toHaveBeenCalledOnce();
  await client.dispose();

  // A reload over the same database resumes from it.
  const next = createSyncClient(config);
  next.startSync();
  await vi.waitFor(() => expect(adapter.streams).toHaveLength(2));
  expect(adapter.streams[1].checkpoint).toEqual({ todos: new Stamp(5) });
  await next.dispose();
});

test("a rolled back pull transaction keeps the previous checkpoint", async () => {
  const { db, store } = transactionalDb();
  await store.saveCheckpoint("todos", "1");
  const transaction = db.transaction.getMockImplementation();
  const failure = new Error("commit failed");
  const saved: string[] = [];
  // Snapshot the checkpoint, run the batch, then fail the commit and restore the snapshot.
  db.transaction.mockImplementationOnce(async (fn: any) => {
    const before = await store.getCheckpoint("todos");
    await transaction(fn);
    saved.push((await store.getCheckpoint("todos"))!);
    await store.saveCheckpoint("todos", before);
    throw failure;
  });
  const adapter = pullAdapter();
  const statuses: unknown[] = [];
  const client = createSyncClient(
    clientConfig(db, {
      collections: [{ ...collection, syncAdapter: adapter }],
      checkpointSerializer: stampCheckpoint,
      onSyncStatus: (event: any) => statuses.push(event.error),
    }),
  );
  client.startSync();
  await vi.waitFor(() => expect(adapter.streams).toHaveLength(1));
  expect(adapter.streams[0].checkpoint).toEqual({ todos: new Stamp(1) });
  adapter.streams[0].commitChanges({ changes: [], checkpoint: { todos: new Stamp(5) } });
  await vi.waitFor(() => expect(statuses).toContain(failure));
  // The checkpoint was written in the transaction, so it rolled back with it.
  expect(saved).toEqual(["5"]);
  expect(await store.getCheckpoint("todos")).toBe("1");
  expect(await client.getCheckpoint("todos")).toEqual(new Stamp(1));
  await client.dispose();
});

test("a reset database pulls again from no checkpoint", async () => {
  const adapter = pullAdapter();
  const first = createSyncClient(
    clientConfig(transactionalDb().db, { collections: [{ ...collection, syncAdapter: adapter }] }),
  );
  first.startSync();
  await vi.waitFor(() => expect(adapter.streams).toHaveLength(1));
  adapter.streams[0].commitChanges({ changes: [], checkpoint: { todos: "c9" } });
  await vi.waitFor(async () => expect(await first.getCheckpoint("todos")).toBe("c9"));
  await first.dispose();

  // The database is gone (a cleared IndexedDB, a logout): its checkpoints went with it.
  const second = createSyncClient(
    clientConfig(transactionalDb().db, { collections: [{ ...collection, syncAdapter: adapter }] }),
  );
  second.startSync();
  await vi.waitFor(() => expect(adapter.streams).toHaveLength(2));
  expect(adapter.streams[1].checkpoint).toBeUndefined();
  await tick();
  await second.dispose();
});
