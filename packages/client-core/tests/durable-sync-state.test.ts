import { expect, test, vi } from "vite-plus/test";
import {
  createDBCheckpointStorage,
  createLocalStorageCheckpointStorage,
  isTransactionalCheckpointStorage,
} from "../src/checkpoint-storage";
import { createSyncClient } from "../src/sync-client";
import { createTestLocalChangeStore } from "./helpers/local-change-store";
import { clientConfig, makeDb } from "./helpers/storage";
import { fixture, settle, type Row } from "./helpers/sync-fixture";

/** A checkpoint that is not plain JSON, like a Firestore `Timestamp`. */
class Stamp {
  constructor(readonly millis: number) {}
}
const stampSerialization = {
  serializer: (stamp: Stamp) => (stamp.millis > 0 ? String(stamp.millis) : undefined),
  deserializer: (value: string) => new Stamp(Number(value)),
};

const localEvent = (id: string, data: Row) => ({
  id,
  type: "update" as const,
  collection: "todos",
  recordId: String(data.id),
  data,
  createdAt: 1,
});
const echo = (title: string, updatedAt: number) => ({
  type: "update" as const,
  collection: "todos",
  data: { id: 1, title, updatedAt },
});

test("the DB checkpoint storage serializes into the local-change store, in a given transaction", async () => {
  const localChangeStore = createTestLocalChangeStore();
  const save = vi.spyOn(localChangeStore, "saveCheckpoint");
  const get = vi.spyOn(localChangeStore, "getCheckpoint");
  const storage = createDBCheckpointStorage<string, Stamp>({
    localChangeStore,
    ...stampSerialization,
  });
  expect(isTransactionalCheckpointStorage(storage)).toBe(true);
  expect(storage.localChangeStore).toBe(localChangeStore);
  expect(await storage.getCheckpoint("todos")).toBeUndefined();

  const native = { transaction: "pull" };
  await storage.saveCheckpoint("todos", new Stamp(8), native);
  await storage.saveCheckpoint("users", new Stamp(4));
  expect(save.mock.calls).toEqual([
    ["todos", "8", native],
    ["users", "4", undefined],
  ]);
  // The stored value round-trips through the deserializer, back to its class.
  const read = await storage.getCheckpoint("todos", native);
  expect(read).toBeInstanceOf(Stamp);
  expect(read).toEqual(new Stamp(8));
  expect(get).toHaveBeenLastCalledWith("todos", native);
  expect(await storage.getCheckpoint("users")).toEqual(new Stamp(4));

  // An empty serialization removes the checkpoint.
  await storage.saveCheckpoint("todos", new Stamp(0));
  expect(await localChangeStore.getCheckpoint("todos")).toBeUndefined();
  expect(await storage.getCheckpoint("todos")).toBeUndefined();
});

test("only storages bound to a local-change store are transactional", () => {
  expect(
    isTransactionalCheckpointStorage({
      getCheckpoint: async () => undefined,
      saveCheckpoint: async () => {},
    }),
  ).toBe(false);
  expect(
    isTransactionalCheckpointStorage(
      createLocalStorageCheckpointStorage({
        key: "sync",
        serializer: String,
        deserializer: Number,
      }),
    ),
  ).toBe(false);
});

for (const scope of ["global", "collection"] as const) {
  /** A handler whose checkpoints live in its own local-change store. */
  const dbFixture = () => {
    const localChangeStore = createTestLocalChangeStore();
    const checkpointStorage = createDBCheckpointStorage<string, Stamp>({
      localChangeStore,
      ...stampSerialization,
    });
    return fixture(scope, { localChangeStore, checkpointStorage });
  };

  test(`${scope}: a DB checkpoint is saved inside the pull transaction, with its rows`, async () => {
    const f = dbFixture();
    let inTransaction = false;
    const transaction = f.db.transaction.getMockImplementation()!;
    f.db.transaction.mockImplementation(async (fn) => {
      inTransaction = true;
      try {
        return await transaction(fn);
      } finally {
        inTransaction = false;
      }
    });
    const saved: boolean[] = [];
    const original = f.store.saveCheckpoint.bind(f.store);
    const spy = vi.spyOn(f.store, "saveCheckpoint").mockImplementation(async (...args) => {
      saved.push(inTransaction);
      return original(...args);
    });
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    expect(f.streams[0]!.options.checkpoint).toEqual(scope === "global" ? {} : undefined);
    f.streams[0]!.options.commitChanges({
      changes: [{ type: "create", collection: "todos", data: { id: 1, title: "one" } }],
      checkpoint: { todos: new Stamp(5) },
    });
    await vi.waitFor(async () => expect(await f.store.getCheckpoint("todos")).toBe("5"));
    expect(spy).toHaveBeenCalledExactlyOnceWith("todos", "5", f.native);
    expect(saved).toEqual([true]);
    expect(f.db.transaction).toHaveBeenCalledOnce();
    expect(f.rows.get("1")).toEqual({ id: 1, title: "one" });

    // The next stream resumes from it.
    f.stop();
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(2));
    expect(f.streams[1]!.options.checkpoint).toEqual({ todos: new Stamp(5) });
    f.stop();
  });

  test(`${scope}: a failed pull transaction saves no DB checkpoint`, async () => {
    const f = dbFixture();
    await f.store.saveCheckpoint("todos", "1");
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    const failure = new Error("disk full");
    f.db.insert.mockRejectedValueOnce(failure);
    f.streams[0]!.options.commitChanges({
      changes: [{ type: "create", collection: "todos", data: { id: 1, title: "one" } }],
      checkpoint: { todos: new Stamp(5) },
    });
    await vi.waitFor(() => expect(f.onSyncError).toHaveBeenCalledWith(failure));
    expect(await f.store.getCheckpoint("todos")).toBe("1");
    // The stream resubscribes from the checkpoint that was committed.
    await vi.waitFor(() => expect(f.streams).toHaveLength(2));
    expect(f.streams[1]!.options.checkpoint).toEqual({ todos: new Stamp(1) });
    f.stop();
  });

  test(`${scope}: a batch without changes saves its DB checkpoint in a transaction`, async () => {
    const f = dbFixture();
    const save = vi.spyOn(f.store, "saveCheckpoint");
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    f.streams[0]!.options.commitChanges({ changes: [], checkpoint: { todos: new Stamp(7) } });
    await vi.waitFor(async () => expect(await f.store.getCheckpoint("todos")).toBe("7"));
    expect(save).toHaveBeenCalledExactlyOnceWith("todos", "7", f.native);
    expect(f.db.transaction).toHaveBeenCalledOnce();
    f.stop();
  });

  test(`${scope}: a reset database resumes from no checkpoint, whatever survives elsewhere`, async () => {
    const f = dbFixture();
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    f.streams[0]!.options.commitChanges({ changes: [], checkpoint: { todos: new Stamp(9) } });
    await vi.waitFor(async () => expect(await f.store.getCheckpoint("todos")).toBe("9"));
    f.stop();

    // The database is gone (a new in-memory storage, a cleared IndexedDB, a logout): the
    // checkpoint went with it, so the next pull starts over and fetches every record again.
    const g = dbFixture();
    g.start();
    await vi.waitFor(() => expect(g.streams).toHaveLength(1));
    expect(g.streams[0]!.options.checkpoint).toEqual(scope === "global" ? {} : undefined);
    g.stop();
  });

  test(`${scope}: a non-transactional checkpoint storage saves after the pull commits`, async () => {
    const f = fixture(scope);
    let inTransaction = false;
    const transaction = f.db.transaction.getMockImplementation()!;
    f.db.transaction.mockImplementation(async (fn) => {
      inTransaction = true;
      try {
        return await transaction(fn);
      } finally {
        inTransaction = false;
      }
    });
    const saved: boolean[] = [];
    f.checkpointStorage.saveCheckpoint.mockImplementation(async (name, checkpoint) => {
      saved.push(inTransaction);
      f.checkpoints.set(name, checkpoint);
    });
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    f.streams[0]!.options.commitChanges({
      changes: [{ type: "create", collection: "todos", data: { id: 1, title: "one" } }],
      checkpoint: { todos: "c1" },
    });
    await vi.waitFor(() => expect(f.checkpoints.get("todos")).toBe("c1"));
    // Exactly the two arguments of `ICheckpointStorage.saveCheckpoint`, after the commit.
    expect(f.checkpointStorage.saveCheckpoint.mock.calls).toEqual([["todos", "c1"]]);
    expect(saved).toEqual([false]);
    // A batch without changes opens no transaction.
    f.streams[0]!.options.commitChanges({ changes: [], checkpoint: { todos: "c2" } });
    await vi.waitFor(() => expect(f.checkpoints.get("todos")).toBe("c2"));
    expect(f.db.transaction).toHaveBeenCalledOnce();
    f.stop();
  });

  test(`${scope}: a DB checkpoint storage of another store is saved after the commit`, async () => {
    const other = createTestLocalChangeStore();
    const checkpointStorage = createDBCheckpointStorage<string, Stamp>({
      localChangeStore: other,
      ...stampSerialization,
    });
    const save = vi.spyOn(other, "saveCheckpoint");
    const f = fixture(scope, { checkpointStorage });
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    f.streams[0]!.options.commitChanges({ changes: [], checkpoint: { todos: new Stamp(3) } });
    await vi.waitFor(async () => expect(await other.getCheckpoint("todos")).toBe("3"));
    // Its transactions belong to another database: none is joined.
    expect(save).toHaveBeenCalledExactlyOnceWith("todos", "3", undefined);
    expect(f.db.transaction).not.toHaveBeenCalled();
    f.stop();
  });

  test(`${scope}: a skipped remote event is stored in the pull transaction and survives a reload`, async () => {
    const f = fixture(scope);
    const upsert = vi.spyOn(f.store, "upsertSkippedRemoteEvent");
    await f.writeLocally(localEvent("e1", { id: 1, title: "local" }));
    // The first handler never sees its push acknowledged.
    f.adapter.push.mockImplementation(() => new Promise(() => {}));
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    f.streams[0]!.options.commitChanges({
      changes: [echo("local", 100)],
      checkpoint: { todos: "c1" },
    });
    await vi.waitFor(() => expect(f.checkpoints.get("todos")).toBe("c1"));
    expect(upsert).toHaveBeenCalledExactlyOnceWith(
      { collection: "todos", recordId: "1", event: echo("local", 100) },
      f.native,
    );
    expect(f.rows.get("1")).toEqual({ id: 1, title: "local" });

    // A reload (or a new leader) before the acknowledgement: a new handler pushes e1 again.
    f.reload();
    f.adapter.push.mockImplementation(async ({ events, commitChanges }: any) => {
      await commitChanges({ events });
    });
    const remove = vi.spyOn(f.store, "removeSkippedRemoteEvents");
    f.start();
    await vi.waitFor(() =>
      expect(f.rows.get("1")).toEqual({ id: 1, title: "local", updatedAt: 100 }),
    );
    expect(remove).toHaveBeenCalledExactlyOnceWith(
      [{ collection: "todos", recordId: "1" }],
      f.native,
    );
    expect(await f.store.getSkippedRemoteEvents()).toEqual([]);
    expect(await f.store.getPendingEvents()).toEqual([]);
    expect(f.onRemoteChangesCommitted).toHaveBeenCalledExactlyOnceWith([echo("local", 100)]);
    expect(f.published.at(-1)).toEqual([echo("local", 100)]);
    f.stop();
  });

  test(`${scope}: a remote delete skipped before a reload is applied by the acknowledgement`, async () => {
    const f = fixture(scope);
    await f.writeLocally(localEvent("e1", { id: 1, title: "local" }));
    f.adapter.push.mockImplementation(() => new Promise(() => {}));
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    const remoteDelete = { type: "delete", collection: "todos", id: 1, deletedAt: 5 };
    f.streams[0]!.options.commitChanges({ changes: [remoteDelete], checkpoint: {} });
    await vi.waitFor(async () => expect(await f.store.getSkippedRemoteEvents()).toHaveLength(1));
    f.reload();
    f.adapter.push.mockImplementation(async ({ events, commitChanges }: any) => {
      await commitChanges({ events });
    });
    f.start();
    await vi.waitFor(() => expect(f.rows.has("1")).toBe(false));
    expect(f.onRemoteChangesCommitted).toHaveBeenCalledExactlyOnceWith([remoteDelete]);
    await settle();
    f.stop();
  });
}

test("sync clients refuse a DB checkpoint storage of another adapter's store", () => {
  const db = makeDb();
  const checkpointStorage = createDBCheckpointStorage({
    localChangeStore: createTestLocalChangeStore(),
    serializer: String,
    deserializer: Number,
  });
  expect(() => createSyncClient(clientConfig(db, { checkpointStorage }))).toThrow(
    "The DB checkpoint storage must use the local-change store of the sync client's adapter.",
  );
  const own = createDBCheckpointStorage({
    localChangeStore: db.localChangeStore,
    serializer: String,
    deserializer: Number,
  });
  const client = createSyncClient(clientConfig(db, { checkpointStorage: own }));
  void client.dispose();
});
