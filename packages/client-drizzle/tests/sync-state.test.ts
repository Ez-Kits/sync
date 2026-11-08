import {
  createLocalDBStorage,
  createSyncClient,
  type DBStorage,
  type StoredChangeBusEvent,
  type SyncStatusEvent,
} from "@ez-kits/sync-client-core";
import { openPGliteEngine } from "@ez-kits/sync-client-storage-pglite/worker";
import { openSqlJsEngine } from "@ez-kits/sync-client-storage-sqljs/worker";
import { pgTable, text as pgText } from "drizzle-orm/pg-core";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { expect, test, vi } from "vite-plus/test";
import { defineDrizzleCollection } from "../src/collection";
import { createDrizzlePgDBAdapter } from "../src/pg";
import { createDrizzleSqliteDBAdapter } from "../src/sqlite";

const run = (sql: string) => ({ sql, params: [], method: "run" as const });
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
    collection: () =>
      defineDrizzleCollection({ name: "todos", table: pgTodos, primaryField: "id" }),
    adapter: (dbStorage: DBStorage) =>
      createDrizzlePgDBAdapter({
        dbStorage,
        collections: [
          defineDrizzleCollection({ name: "todos", table: pgTodos, primaryField: "id" }),
        ],
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
    checkpointSerializer: {
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
  test(`${dialect.name}: revisions are kept per record and replaced`, async () => {
    const dbStorage = dialect.storage();
    const { localChangeStore: store } = dialect.adapter(dbStorage);
    await store.initialize();
    const key = { collection: "todos", recordId: "a" };
    expect(await store.getRevision(key)).toBeUndefined();
    await store.upsertRevision({ ...key, rev: 2 });
    await store.upsertRevision({ collection: "users", recordId: "a", rev: 9 });
    await store.upsertRevision({ ...key, rev: 3 });
    expect(await store.getRevision(key)).toBe(3);
    expect(await store.getRevision({ collection: "users", recordId: "a" })).toBe(9);
    expect(await store.getRevision({ collection: "todos", recordId: "b" })).toBeUndefined();
    await dbStorage.close();
  }, 30_000);

  test(`${dialect.name}: removing a collection's revisions keeps the records with pending events`, async () => {
    const dbStorage = dialect.storage();
    const { localChangeStore: store } = dialect.adapter(dbStorage);
    await store.initialize();
    const todo = (recordId: string) => ({ collection: "todos", recordId });
    const user = { collection: "users", recordId: "a" };
    await store.upsertRevision({ ...todo("a"), rev: 1 });
    await store.upsertRevision({ ...todo("b"), rev: 2 });
    await store.upsertRevision({ ...user, rev: 3 });
    const pending = { type: "update" as const, data: { id: "x" }, createdAt: 1 };
    await store.appendEvents([
      { id: "e1", ...todo("b"), ...pending },
      // Pending in another collection: does not keep `todos`' record of the same id.
      { id: "e2", ...user, ...pending },
    ]);

    await store.removeRevisions("todos");
    expect(await store.getRevision(todo("a"))).toBeUndefined();
    expect(await store.getRevision(todo("b"))).toBe(2);
    expect(await store.getRevision(user)).toBe(3);
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
    expect(await after.adapter.localChangeStore.getSkippedRemoteEvents()).toEqual([]);
    expect(after.errors).toEqual([]);
    after.client.stopSync();
    await dbStorage.close();
  }, 30_000);
}
