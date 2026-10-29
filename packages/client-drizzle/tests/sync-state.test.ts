import {
  createLocalDBStorage,
  createSyncClient,
  type DBStorage,
  type StoredChangeBusEvent,
  type SyncStatusEvent,
} from "@ez-kits/sync-client-core";
import { openPGliteEngine } from "@ez-kits/sync-storage-pglite/worker";
import { openSqlJsEngine } from "@ez-kits/sync-storage-sqljs/worker";
import { pgTable, text as pgText } from "drizzle-orm/pg-core";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { expect, test, vi } from "vite-plus/test";
import { defineDrizzleCollection } from "../src/collection";
import { createDrizzlePgDBAdapter } from "../src/pg";
import { createDrizzleSqliteDBAdapter } from "../src/sqlite";

const run = (sql: string) => ({ sql, params: [], method: "run" as const });
const rowsOf = async (storage: DBStorage, sql: string) =>
  (await storage.exec({ sql, params: [], method: "all", rowMode: "object" })).rows;
const TODOS = "CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT);";

const sqliteTodos = sqliteTable("todos", { id: text("id").primaryKey(), title: text("title") });
const pgTodos = pgTable("todos", { id: pgText("id").primaryKey(), title: pgText("title") });

const dialects = [
  {
    name: "sql.js",
    storage: () =>
      createLocalDBStorage({
        dialect: "sqlite",
        open: async () => {
          const engine = await openSqlJsEngine();
          await engine.exec(run(TODOS));
          return engine;
        },
      }),
    collection: () => defineDrizzleCollection({ name: "todos", table: sqliteTodos }),
    adapter: (dbStorage: DBStorage) =>
      createDrizzleSqliteDBAdapter({
        dbStorage,
        collections: [defineDrizzleCollection({ name: "todos", table: sqliteTodos })],
      }),
  },
  {
    name: "PGlite",
    storage: () =>
      createLocalDBStorage({
        dialect: "postgres",
        open: async () => {
          const engine = await openPGliteEngine();
          await engine.exec(run(TODOS));
          return engine;
        },
      }),
    collection: () => defineDrizzleCollection({ name: "todos", table: pgTodos }),
    adapter: (dbStorage: DBStorage) =>
      createDrizzlePgDBAdapter({
        dbStorage,
        collections: [defineDrizzleCollection({ name: "todos", table: pgTodos })],
      }),
  },
];

const event = (id: string, createdAt: number, recordId = "a"): StoredChangeBusEvent => ({
  id,
  type: "update",
  collection: "todos",
  data: { id: recordId, title: id },
  recordId,
  createdAt,
});

/** A checkpoint that is not plain JSON, like a Firestore `Timestamp`. */
class Stamp {
  constructor(readonly millis: number) {}
}

/** A sync client over `dbStorage`; it serializes its checkpoints into the database. */
function dbSyncClient(
  dialect: (typeof dialects)[number],
  dbStorage: DBStorage,
  push: (options: any) => Promise<void>,
) {
  const adapter = dialect.adapter(dbStorage);
  const errors: unknown[] = [];
  const pulls: any[] = [];
  const client = createSyncClient({
    collections: [dialect.collection()],
    dbAdapter: adapter,
    checkpoint: {
      serialize: (stamp: Stamp) => String(stamp.millis),
      deserialize: (value: string) => new Stamp(Number(value)),
    },
    onSyncStatus: (status: SyncStatusEvent) => {
      if (status.status === "error") errors.push(status.error);
    },
    syncAdapter: { push, pull: (pull: any) => void pulls.push(pull) },
  } as never) as any;
  return { adapter, client, errors, pulls };
}

const acknowledge = async ({ events, commitChanges }: any) => {
  await commitChanges({ events });
};
const neverAcknowledge = () => new Promise<void>(() => {});

for (const dialect of dialects) {
  test(`${dialect.name}: initialize upgrades version 3 tables with the checkpoint and skipped-event tables`, async () => {
    const dbStorage = dialect.storage();
    const { localChangeStore } = dialect.adapter(dbStorage);
    await localChangeStore.initialize();
    // Back to version 3: no checkpoint or skipped-event table, one pending event.
    await localChangeStore.appendEvents([event("pending", 1)]);
    await dbStorage.exec(run("DROP TABLE ez_sync_checkpoints"));
    await dbStorage.exec(run("DROP TABLE ez_sync_skipped_remote_events"));
    await dbStorage.exec(run("UPDATE ez_sync_meta SET value = 3 WHERE key = 'schema_version'"));

    // Several contexts initialize together; the transactions serialize on the leader.
    await Promise.all([
      dialect.adapter(dbStorage).localChangeStore.initialize(),
      dialect.adapter(dbStorage).localChangeStore.initialize(),
    ]);
    expect(await rowsOf(dbStorage, "SELECT key, value FROM ez_sync_meta")).toEqual([
      { key: "schema_version", value: 4 },
    ]);
    expect((await localChangeStore.getPendingEvents()).map(({ id }) => id)).toEqual(["pending"]);
    await localChangeStore.saveCheckpoint("todos", "c1");
    expect(await localChangeStore.getCheckpoint("todos")).toBe("c1");
    const skipped = { collection: "todos", recordId: "a", event: { type: "delete", id: "a" } };
    await localChangeStore.upsertSkippedRemoteEvent(skipped);
    expect(await localChangeStore.getSkippedRemoteEvents()).toEqual([skipped]);

    // A later initialize changes nothing.
    const transaction = vi.spyOn(dbStorage, "transaction");
    await dialect.adapter(dbStorage).localChangeStore.initialize();
    expect(transaction).toHaveBeenCalledOnce();
    expect(await localChangeStore.getCheckpoint("todos")).toBe("c1");
    expect(await localChangeStore.getSkippedRemoteEvents()).toEqual([skipped]);
    await dbStorage.close();
  }, 30_000);

  test(`${dialect.name}: checkpoints and skipped remote events are replaced, scoped and removed`, async () => {
    const dbStorage = dialect.storage();
    const { localChangeStore: store } = dialect.adapter(dbStorage);
    await store.initialize();
    expect(await store.getCheckpoint("todos")).toBeUndefined();
    await store.saveCheckpoint("todos", "c1");
    await store.saveCheckpoint("users", "u1");
    await store.saveCheckpoint("todos", "c2");
    expect(await store.getCheckpoint("todos")).toBe("c2");
    await store.saveCheckpoint("todos", undefined);
    expect(await store.getCheckpoint("todos")).toBeUndefined();
    expect(await store.getCheckpoint("users")).toBe("u1");

    const update = (recordId: string, title: string, collection = "todos") => ({
      collection,
      recordId,
      event: { type: "update", collection, data: { id: recordId, title, n: 1.5 } },
    });
    await store.upsertSkippedRemoteEvent(update("a", "first"));
    await store.upsertSkippedRemoteEvent(update("a", "second"));
    await store.upsertSkippedRemoteEvent(update("b", "other"));
    await store.upsertSkippedRemoteEvent(update("a", "user", "users"));
    expect(await store.getSkippedRemoteEvents({ collection: "todos", recordId: "a" })).toEqual([
      update("a", "second"),
    ]);
    expect(await store.getSkippedRemoteEvents("todos")).toHaveLength(2);
    await store.removeSkippedRemoteEvents([]);
    await store.removeSkippedRemoteEvents([
      { collection: "todos", recordId: "a" },
      { collection: "todos", recordId: "b" },
    ]);
    expect(await store.getSkippedRemoteEvents()).toEqual([update("a", "user", "users")]);
    await dbStorage.close();
  }, 30_000);

  test(`${dialect.name}: a DB checkpoint commits and rolls back with the pulled rows`, async () => {
    const dbStorage = dialect.storage();
    const { adapter, client, errors, pulls } = dbSyncClient(dialect, dbStorage, acknowledge);
    await adapter.localChangeStore.initialize();
    client.startSync();
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    expect(pulls[0].checkpoint).toEqual({});
    pulls[0].commitChanges({
      changes: [{ type: "create", collection: "todos", data: { id: "a", title: "one" } }],
      checkpoint: { todos: new Stamp(1) },
    });
    await vi.waitFor(async () => expect(await client.getCheckpoint("todos")).toEqual(new Stamp(1)));
    expect(await adapter.getMany("todos")).toEqual([{ id: "a", title: "one" }]);

    // The checkpoint is written, then the transaction fails: neither row nor checkpoint stays.
    const store = adapter.localChangeStore;
    const save = store.saveCheckpoint.bind(store);
    vi.spyOn(store, "saveCheckpoint").mockImplementationOnce(async (...args) => {
      await save(...args);
      throw new Error("commit failed");
    });
    pulls[0].commitChanges({
      changes: [{ type: "create", collection: "todos", data: { id: "b", title: "two" } }],
      checkpoint: { todos: new Stamp(2) },
    });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect((errors[0] as Error).message).toBe("commit failed");
    expect(await adapter.getMany("todos")).toEqual([{ id: "a", title: "one" }]);
    expect(await store.getCheckpoint("todos")).toBe("1");
    // The stream resubscribes from the checkpoint that committed.
    await vi.waitFor(() => expect(pulls).toHaveLength(2));
    expect(pulls[1].checkpoint).toEqual({ todos: new Stamp(1) });
    client.stopSync();
    await dbStorage.close();
  }, 30_000);

  test(`${dialect.name}: a reset database pulls everything again from no checkpoint`, async () => {
    const first = dialect.storage();
    const before = dbSyncClient(dialect, first, acknowledge);
    await before.adapter.localChangeStore.initialize();
    before.client.startSync();
    await vi.waitFor(() => expect(before.pulls).toHaveLength(1));
    before.pulls[0].commitChanges({
      changes: [{ type: "create", collection: "todos", data: { id: "a", title: "one" } }],
      checkpoint: { todos: new Stamp(5) },
    });
    await vi.waitFor(async () =>
      expect(await before.adapter.localChangeStore.getCheckpoint("todos")).toBe("5"),
    );
    before.client.stopSync();
    await first.close();

    // An in-memory storage opened again (or a cleared IndexedDB): rows and checkpoint are gone.
    const reset = dialect.storage();
    const after = dbSyncClient(dialect, reset, acknowledge);
    await after.adapter.localChangeStore.initialize();
    after.client.startSync();
    await vi.waitFor(() => expect(after.pulls).toHaveLength(1));
    expect(after.pulls[0].checkpoint).toEqual({});
    after.client.stopSync();
    await reset.close();
  }, 30_000);

  test(`${dialect.name}: a skipped remote event survives a reload and is applied by the acknowledgement`, async () => {
    const dbStorage = dialect.storage();
    const before = dbSyncClient(dialect, dbStorage, neverAcknowledge);
    const store = before.adapter.localChangeStore;
    await store.initialize();
    await before.adapter.commitLocalMutation({
      mutate: ({ operations }) => operations.insert("todos", { id: "a", title: "local" }),
      persistOutboxEvent: ({ native }) =>
        store.appendEvents(
          [{ ...event("e1", 1), type: "create", data: { id: "a", title: "local" } }],
          native,
        ),
      persistDirtyRecord: ({ native }) =>
        store.upsertDirtyRecord(
          { collection: "todos", recordId: "a", state: "dirty", updatedAt: 1 },
          native,
        ),
    });
    before.client.startSync();
    await vi.waitFor(() => expect(before.pulls).toHaveLength(1));
    // The server's copy of the pushed write, pulled before its acknowledgement.
    const echo = { type: "update", collection: "todos", data: { id: "a", title: "server" } };
    before.pulls[0].commitChanges({ changes: [echo], checkpoint: { todos: new Stamp(1) } });
    await vi.waitFor(async () => expect(await store.getCheckpoint("todos")).toBe("1"));
    expect(await store.getSkippedRemoteEvents()).toEqual([
      { collection: "todos", recordId: "a", event: echo },
    ]);
    expect(await before.adapter.getMany("todos")).toEqual([{ id: "a", title: "local" }]);
    before.client.stopSync();

    // A reload: a new adapter and client on the same database push e1 again.
    const after = dbSyncClient(dialect, dbStorage, acknowledge);
    await after.adapter.localChangeStore.initialize();
    after.client.startSync();
    await vi.waitFor(async () =>
      expect(await after.adapter.getMany("todos")).toEqual([{ id: "a", title: "server" }]),
    );
    expect(await after.adapter.localChangeStore.getPendingEvents()).toEqual([]);
    expect(await after.adapter.localChangeStore.getDirtyRecords()).toEqual([]);
    expect(await after.adapter.localChangeStore.getSkippedRemoteEvents()).toEqual([]);
    expect(after.errors).toEqual([]);
    after.client.stopSync();
    await dbStorage.close();
  }, 30_000);
}
