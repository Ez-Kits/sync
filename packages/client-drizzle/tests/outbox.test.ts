import {
  APPLIED_EVENT_RETENTION_MS,
  ChangeBus,
  createLocalDBStorage,
  GlobalSyncHandler,
  TransactionClosedError,
  type DBStorage,
  type StoredChangeBusEvent,
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
const rowsOf = async (storage: DBStorage, sql: string) =>
  (await storage.exec({ sql, params: [], method: "all", rowMode: "object" })).rows;

const sqliteTodos = sqliteTable("todos", { id: text("id").primaryKey(), title: text("title") });
const pgTodos = pgTable("todos", { id: pgText("id").primaryKey(), title: pgText("title") });

const dialects = [
  {
    name: "sql.js",
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
  },
  {
    name: "PGlite",
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
    // What the client counts: ids and collections only.
    expect(
      (await localChangeStore.getPendingEventKeys!()).sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(["a", "b", "m", "z"].map((id) => ({ id, collection: "todos" })));
    expect(ids(await localChangeStore.getPendingEvents("todos"))).toEqual(["z", "m", "b", "a"]);
    const recordA = await localChangeStore.getPendingEvents({ collection: "todos", recordId: "a" });
    // `seq` stays internal: events read back have the stored fields only.
    expect(recordA).toEqual([event("z", 5), event("m", 5), event("a", 5)]);
    await dbStorage.close();
  }, 30_000);

  test(`${dialect.name}: initialize creates the tables once, and later calls change nothing`, async () => {
    const dbStorage = dialect.storage("CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT);");
    const { localChangeStore } = dialect.adapter(dbStorage);
    // Several contexts initialize together; the transactions serialize on the leader.
    await Promise.all([localChangeStore.initialize(), localChangeStore.initialize()]);
    expect(await rowsOf(dbStorage, "SELECT key, value FROM ez_sync_meta")).toEqual([
      { key: "schema_version", value: 6 },
    ]);
    await localChangeStore.appendEvents([event("pending", 1)]);

    const transaction = vi.spyOn(dbStorage, "transaction");
    await localChangeStore.initialize();
    expect(transaction).toHaveBeenCalledOnce();
    expect((await localChangeStore.getPendingEvents()).map(({ id }) => id)).toEqual(["pending"]);
    await dbStorage.close();
  }, 30_000);

  test(`${dialect.name}: a version 4 database gets the revisions table, loses the dirty-record table and keeps its data`, async () => {
    const dbStorage = dialect.storage("CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT);");
    const { localChangeStore } = dialect.adapter(dbStorage);
    await localChangeStore.initialize();
    await localChangeStore.appendEvents([event("pending", 1)]);
    await dbStorage.exec({ sql: "DROP TABLE ez_sync_revisions", params: [], method: "run" });
    await dbStorage.exec({
      sql: "CREATE TABLE ez_sync_dirty_records (collection TEXT)",
      params: [],
      method: "run",
    });
    await dbStorage.exec({
      sql: "UPDATE ez_sync_meta SET value = 4 WHERE key = 'schema_version'",
      params: [],
      method: "run",
    });

    await localChangeStore.initialize();
    const key = { collection: "todos", recordId: "a" };
    await expect(
      dbStorage.exec({ sql: "SELECT 1 FROM ez_sync_dirty_records", params: [], method: "all" }),
    ).rejects.toThrow();
    await localChangeStore.upsertRevision({ ...key, rev: 2 });
    expect(await localChangeStore.getRevision(key)).toBe(2);
    expect((await localChangeStore.getPendingEvents()).map(({ id }) => id)).toEqual(["pending"]);
    expect(await rowsOf(dbStorage, "SELECT key, value FROM ez_sync_meta")).toEqual([
      { key: "schema_version", value: 6 },
    ]);
    await dbStorage.close();
  }, 30_000);

  test(`${dialect.name}: applied events outlive their acknowledgement until pruned`, async () => {
    const dbStorage = dialect.storage("CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT);");
    const { localChangeStore } = dialect.adapter(dbStorage);
    await localChangeStore.initialize();
    await localChangeStore.appendEvents([event("old", 1), event("kept", 2)]);
    expect(await localChangeStore.hasAppliedEvent("unknown")).toBe(false);
    await localChangeStore.deleteEvents(["old", "kept"]);
    expect(await localChangeStore.hasAppliedEvent("old")).toBe(true);

    // Only records older than the retention, counted from the newest appended event, go.
    await localChangeStore.appendEvents([event("new", 2 + APPLIED_EVENT_RETENTION_MS)]);
    expect(await localChangeStore.hasAppliedEvent("old")).toBe(false);
    expect(await localChangeStore.hasAppliedEvent("kept")).toBe(true);
    expect(await localChangeStore.hasAppliedEvent("new")).toBe(true);
    await dbStorage.close();
  }, 30_000);
}

/** A leader-side global sync handler over the sql.js adapter, with a scripted provider. */
async function syncSetup(options: {
  transactionTimeoutMs?: number;
  resolveConflict?: (input: { remote: unknown; local: unknown }) => "remote" | "local";
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
    resolveConflict: options.resolveConflict as never,
    onSyncError: (error: unknown) => errors.push(error),
    onRemoteChangesCommitted: committed,
    syncAdapter: {
      push,
      pull: (pull: any) => {
        pullOptions = pull;
      },
    },
  } as never);
  /** A local write, committed with its outbox event. */
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

test("a failure part way through an acknowledgement leaves the outbox as it was", async () => {
  const { dbStorage, adapter, handler, errors, push, writeLocally } = await syncSetup({});
  await writeLocally("a", "one", "e1", "create");
  await writeLocally("a", "two", "e2");
  const store = adapter.localChangeStore;
  // Events are deleted first; the per-record lookup after them fails.
  const deleteEvents = vi.spyOn(store, "deleteEvents");
  const getPendingEvents = store.getPendingEvents.bind(store);
  vi.spyOn(store, "getPendingEvents").mockImplementation((scope, transactionContext) =>
    typeof scope === "object" && transactionContext
      ? Promise.reject(new Error("disk full"))
      : getPendingEvents(scope, transactionContext),
  );
  handler.start();
  await vi.waitFor(() => expect(errors).toHaveLength(1));
  handler.stop();
  expect(push).toHaveBeenCalledOnce();
  expect(deleteEvents).toHaveBeenCalledOnce();
  expect((errors[0] as Error).message).toBe("disk full");
  // The whole acknowledgement rolled back: the events will be pushed again.
  expect((await store.getPendingEvents()).map(({ id }) => id)).toEqual(["e1", "e2"]);
  await dbStorage.close();
});

test("a pull with a conflict resolver and pending local events commits without a timeout", async () => {
  const resolveConflict = vi.fn(() => "remote" as const);
  const { dbStorage, adapter, handler, errors, committed, push, writeLocally, pull } =
    await syncSetup({ transactionTimeoutMs: 300, resolveConflict });
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
  expect(resolveConflict).toHaveBeenCalledExactlyOnceWith({
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
