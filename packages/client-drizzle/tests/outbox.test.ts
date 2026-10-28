import {
  ChangeBus,
  createLocalDBStorage,
  GlobalSyncHandler,
  TransactionClosedError,
  type DBStorage,
  type StoredChangeBusEvent,
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

const sqliteTodos = sqliteTable("todos", { id: text("id").primaryKey(), title: text("title") });
const pgTodos = pgTable("todos", { id: pgText("id").primaryKey(), title: pgText("title") });

/** The outbox tables as version 1 created them: keyed by `id`, no `seq`, no meta table. */
const SQLITE_V1 = `
CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT);
CREATE TABLE ez_sync_events (
  id TEXT PRIMARY KEY NOT NULL, type TEXT NOT NULL, collection TEXT NOT NULL, data TEXT,
  recordId TEXT NOT NULL, createdAt INTEGER NOT NULL
);
CREATE TABLE ez_sync_dirty_records (
  collection TEXT NOT NULL, recordId TEXT NOT NULL, state TEXT NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX ez_sync_dirty_record_key ON ez_sync_dirty_records (collection, recordId);
`;
const PG_V1 = `
CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT);
CREATE TABLE ez_sync_events (
  id TEXT PRIMARY KEY NOT NULL, type TEXT NOT NULL, collection TEXT NOT NULL, data JSONB,
  "recordId" TEXT NOT NULL, "createdAt" BIGINT NOT NULL
);
CREATE TABLE ez_sync_dirty_records (
  collection TEXT NOT NULL, "recordId" TEXT NOT NULL, state TEXT NOT NULL, "updatedAt" BIGINT NOT NULL
);
CREATE UNIQUE INDEX ez_sync_dirty_record_key ON ez_sync_dirty_records (collection, "recordId");
`;

const dialects = [
  {
    name: "sql.js",
    v1: SQLITE_V1,
    storage: (schema: string, transactionTimeoutMs?: number) =>
      createLocalDBStorage({
        dialect: "sqlite",
        transactionTimeoutMs,
        open: async () => {
          const engine = await openSqlJsEngine();
          await engine.exec(run(schema));
          return engine;
        },
      }),
    adapter: (dbStorage: DBStorage) =>
      createDrizzleSqliteDBAdapter({
        dbStorage,
        collections: [defineDrizzleCollection({ name: "todos", table: sqliteTodos })],
      }),
    seqColumn: "SELECT name FROM pragma_table_info('ez_sync_events') WHERE name = 'seq'",
  },
  {
    name: "PGlite",
    v1: PG_V1,
    storage: (schema: string, transactionTimeoutMs?: number) =>
      createLocalDBStorage({
        dialect: "postgres",
        transactionTimeoutMs,
        open: async () => {
          const engine = await openPGliteEngine();
          await engine.exec(run(schema));
          return engine;
        },
      }),
    adapter: (dbStorage: DBStorage) =>
      createDrizzlePgDBAdapter({
        dbStorage,
        collections: [defineDrizzleCollection({ name: "todos", table: pgTodos })],
      }),
    seqColumn:
      "SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'ez_sync_events' AND column_name = 'seq'",
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

for (const dialect of dialects) {
  test(`${dialect.name}: events of the same millisecond come back in insertion order`, async () => {
    const dbStorage = dialect.storage("CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT);");
    const { localChangeStore } = dialect.adapter(dbStorage);
    await localChangeStore.initialize();
    // Random UUIDs sort arbitrarily: ids that sort backwards must not reorder the writes.
    await localChangeStore.appendEvents([event("z", 5)]);
    await localChangeStore.appendEvents([event("m", 5), event("b", 5, "b")]);
    await localChangeStore.appendEvents([event("a", 5)]);
    const ids = (events: StoredChangeBusEvent[]) => events.map(({ id }) => id);
    expect(ids(await localChangeStore.getPendingEvents())).toEqual(["z", "m", "b", "a"]);
    expect(ids(await localChangeStore.getPendingEvents("todos"))).toEqual(["z", "m", "b", "a"]);
    const recordA = await localChangeStore.getPendingEvents({ collection: "todos", recordId: "a" });
    // `seq` stays internal: events read back have the stored fields only.
    expect(recordA).toEqual([event("z", 5), event("m", 5), event("a", 5)]);
    await dbStorage.close();
  }, 30_000);

  test(`${dialect.name}: initialize migrates version 1 tables once, keeping pending order`, async () => {
    const dbStorage = dialect.storage(dialect.v1);
    // Inserted out of order; version 1 read them by `createdAt, id`.
    for (const [id, createdAt] of [
      ["late", 3],
      ["second", 2],
      ["first-b", 1],
      ["first-a", 1],
    ] as const) {
      await dbStorage.exec({
        sql:
          dialect.name === "PGlite"
            ? `INSERT INTO ez_sync_events (id, type, collection, data, "recordId", "createdAt") VALUES ($1, 'update', 'todos', '{"id":"a"}', 'a', $2)`
            : "INSERT INTO ez_sync_events (id, type, collection, data, recordId, createdAt) VALUES (?, 'update', 'todos', '{\"id\":\"a\"}', 'a', ?)",
        params: [id, createdAt],
        method: "run",
      });
    }
    const { localChangeStore } = dialect.adapter(dbStorage);
    // Several contexts initialize together; the transactions serialize on the leader.
    await Promise.all([localChangeStore.initialize(), localChangeStore.initialize()]);
    expect(await rowsOf(dbStorage, dialect.seqColumn)).toEqual([{ name: "seq" }]);
    expect(await rowsOf(dbStorage, "SELECT key, value FROM ez_sync_meta")).toEqual([
      { key: "schema_version", value: 2 },
    ]);
    const pending = await localChangeStore.getPendingEvents();
    expect(pending.map(({ id }) => id)).toEqual(["first-a", "first-b", "second", "late"]);
    expect(pending[0]).toEqual({ ...event("first-a", 1), data: { id: "a" } });

    // New events follow the copied ones.
    await localChangeStore.appendEvents([event("new", 0)]);
    const snapshot = await rowsOf(dbStorage, "SELECT * FROM ez_sync_events ORDER BY seq");
    expect(snapshot.map((row: any) => [Number(row.seq), row.id])).toEqual([
      [1, "first-a"],
      [2, "first-b"],
      [3, "second"],
      [4, "late"],
      [5, "new"],
    ]);

    // A second initialize changes nothing.
    const execSpy = vi.spyOn(dbStorage, "transaction");
    await localChangeStore.initialize();
    expect(execSpy).toHaveBeenCalledOnce();
    expect(await rowsOf(dbStorage, "SELECT * FROM ez_sync_events ORDER BY seq")).toEqual(snapshot);
    expect(await rowsOf(dbStorage, "SELECT key, value FROM ez_sync_meta")).toEqual([
      { key: "schema_version", value: 2 },
    ]);
    await dbStorage.close();
  }, 30_000);
}

/** A leader-side global sync handler over the sql.js adapter, with a scripted provider. */
async function syncSetup(options: {
  transactionTimeoutMs?: number;
  conflictResolver?: (input: { remote: unknown; local: unknown }) => "remote" | "local";
}) {
  const sqlite = dialects[0]!;
  const dbStorage = sqlite.storage(
    "CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT);",
    options.transactionTimeoutMs,
  );
  const adapter = sqlite.adapter(dbStorage);
  await adapter.localChangeStore.initialize();
  const errors: unknown[] = [];
  const committed = vi.fn();
  let pullOptions: any;
  const push = vi.fn(async ({ events, commitChanges }: any) => {
    await commitChanges({ events });
  });
  const handler = new GlobalSyncHandler({
    collections: [defineDrizzleCollection({ name: "todos", table: sqliteTodos })],
    db: adapter,
    changeBus: new ChangeBus<any>(),
    checkpointStorage: { getCheckpoint: async () => undefined, saveCheckpoint: async () => {} },
    localChangeStore: adapter.localChangeStore,
    conflictResolver: options.conflictResolver as never,
    onSyncError: (error: unknown) => errors.push(error),
    onRemoteChangesCommitted: committed,
    syncAdapter: {
      push,
      pull: (pull: any) => {
        pullOptions = pull;
      },
    },
  } as never);
  /** A local write, committed with its outbox event and dirty record. */
  const writeLocally = (id: string, title: string, eventId: string, type = "update") =>
    adapter.commitLocalMutation({
      mutate: ({ operations }) =>
        type === "create"
          ? operations.insert("todos", { id, title })
          : operations.update("todos", { id, title }),
      persistOutboxEvent: ({ native }) =>
        adapter.localChangeStore.appendEvents(
          [{ ...event(eventId, 1, id), type: type as never, data: { id, title } }],
          native,
        ),
      persistDirtyRecord: ({ native }) =>
        adapter.localChangeStore.upsertDirtyRecord(
          { collection: "todos", recordId: id, state: "dirty", updatedAt: 1 },
          native,
        ),
    });
  return {
    dbStorage,
    adapter,
    handler,
    errors,
    committed,
    push,
    writeLocally,
    pull: () => pullOptions,
  };
}

test("a failure part way through an acknowledgement leaves the outbox and dirty records as they were", async () => {
  const { dbStorage, adapter, handler, errors, push, writeLocally } = await syncSetup({});
  await writeLocally("a", "one", "e1", "create");
  await writeLocally("a", "two", "e2");
  const store = adapter.localChangeStore;
  // Events are deleted first; the dirty-record cleanup after them fails.
  const deleteEvents = vi.spyOn(store, "deleteEvents");
  vi.spyOn(store, "removeDirtyRecords").mockRejectedValue(new Error("disk full"));
  handler.start();
  await vi.waitFor(() => expect(errors).toHaveLength(1));
  handler.stop();
  expect(push).toHaveBeenCalledOnce();
  expect(deleteEvents).toHaveBeenCalledOnce();
  expect((errors[0] as Error).message).toBe("disk full");
  // The whole acknowledgement rolled back: the events will be pushed again.
  expect((await store.getPendingEvents()).map(({ id }) => id)).toEqual(["e1", "e2"]);
  expect(await store.getDirtyRecords()).toEqual([
    { collection: "todos", recordId: "a", state: "dirty", updatedAt: 1 },
  ]);
  await dbStorage.close();
});

test("a pull with a conflict resolver and pending local events commits without a timeout", async () => {
  const conflictResolver = vi.fn(() => "remote" as const);
  const { dbStorage, adapter, handler, errors, committed, push, writeLocally, pull } =
    await syncSetup({ transactionTimeoutMs: 300, conflictResolver });
  // Keep the local event pending: the provider never acknowledges.
  push.mockImplementation(() => new Promise(() => {}));
  await writeLocally("a", "local", "e1", "create");
  handler.start();
  await vi.waitFor(() => expect(pull()).toBeDefined());
  const started = Date.now();
  pull().commitChanges({
    changes: [
      { type: "update", collection: "todos", data: { id: "a", title: "remote" } },
      { type: "create", collection: "todos", data: { id: "b", title: "clean" } },
    ],
    checkpoint: {},
  });
  await vi.waitFor(() => expect(committed).toHaveBeenCalledOnce(), { timeout: 2_000 });
  // Well under the 300 ms timeout: nothing waited for the transaction it ran in.
  expect(Date.now() - started).toBeLessThan(300);
  expect(errors.some((error) => error instanceof TransactionClosedError)).toBe(false);
  expect(errors).toEqual([]);
  // Only the record with local changes went to the resolver, with its local row.
  expect(conflictResolver).toHaveBeenCalledExactlyOnceWith({
    remote: { type: "update", collection: "todos", data: { id: "a", title: "remote" } },
    local: { id: "a", title: "local" },
  });
  expect(await adapter.getMany("todos")).toEqual([
    { id: "a", title: "remote" },
    { id: "b", title: "clean" },
  ]);
  handler.stop();
  await dbStorage.close();
});
