import {
  createLocalDBStorage,
  createSyncClient,
  TransactionStatementError,
  type DBQuery,
  type DBStorage,
} from "@ez-kits/sync-client-core";
import { openPGliteEngine } from "@ez-kits/sync-storage-pglite/worker";
import { openSqlJsEngine } from "@ez-kits/sync-storage-sqljs/worker";
import { asc, defineRelations } from "drizzle-orm";
import {
  boolean,
  getTableConfig as getPgTableConfig,
  pgTable,
  text as pgText,
} from "drizzle-orm/pg-core";
import {
  getTableConfig as getSqliteTableConfig,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { expect, test, vi } from "vite-plus/test";
import { defineDrizzleCollection } from "../src/collection";
import { createDrizzlePgDBAdapter, pgLocalChangeTables } from "../src/pg";
import {
  createDrizzleSqliteDBAdapter,
  sqliteLocalChangeTables,
  sqliteProxyExecutors,
} from "../src/sqlite";

const run = (sql: string) => ({ sql, params: [], method: "run" as const });

const sqliteTodos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
});
const sqliteSchema = `
  CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE notes (id TEXT PRIMARY KEY, todoId TEXT NOT NULL, body TEXT NOT NULL);
`;

const pgTodos = pgTable("todos", {
  id: pgText("id").primaryKey(),
  title: pgText("title").notNull(),
  done: boolean("done").notNull().default(false),
});
const pgSchema = `
  CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL DEFAULT false);
`;

function checkpointStorage() {
  return { getCheckpoint: vi.fn(async () => undefined), saveCheckpoint: vi.fn(async () => {}) };
}

/** The same scenario on every engine: a sync client writing through the Drizzle adapter. */
async function exerciseAdapter(
  adapter: any,
  dbStorage: DBStorage,
  todos: any,
  collection: unknown,
) {
  const client = createSyncClient({
    collections: [collection],
    dbAdapter: adapter,
    checkpointStorage: checkpointStorage(),
  } as never) as any;

  // The client created the outbox tables (the schemas above do not), idempotently.
  await client.collections.todos.insert({ id: "a", title: "first" });
  await adapter.localChangeStore.initialize();
  await client.collections.todos.update({ id: "a", done: true });
  await client.collections.todos.insert({ id: "b", title: "second" });
  await client.collections.todos.delete("b");
  expect(await client.collections.todos.get("a")).toEqual({ id: "a", title: "first", done: true });
  expect(await client.collections.todos.getMany()).toHaveLength(1);

  const pending = await adapter.localChangeStore.getPendingEvents("todos");
  // Commit order, whatever the clock said.
  expect(pending.map((event: any) => `${event.type}:${event.recordId}`)).toEqual([
    "create:a",
    "update:a",
    "create:b",
    "delete:b",
  ]);
  expect(
    pending.find((event: any) => event.type === "create" && event.recordId === "a").data,
  ).toEqual({
    id: "a",
    title: "first",
  });
  expect(await adapter.localChangeStore.getDirtyRecords("todos")).toEqual([
    expect.objectContaining({ recordId: "a", state: "dirty" }),
    expect.objectContaining({ recordId: "b", state: "deleted" }),
  ]);

  // A failing write leaves neither the row nor its outbox event behind.
  await expect(client.collections.todos.insert({ id: "a", title: "duplicate" })).rejects.toThrow();
  expect(await adapter.localChangeStore.getPendingEvents()).toHaveLength(4);

  // Adapter transactions run on one storage transaction and roll back together.
  await expect(
    adapter.transaction(async (tx: any) => {
      await tx.insert("todos", { id: "c", title: "rolled back" });
      throw new Error("abort");
    }),
  ).rejects.toThrow("abort");
  expect(await adapter.getOptional("todos", "c")).toBeUndefined();

  // The query builder runs on the storage; transactions must go through the adapter.
  const rows = await adapter.queryBuilder.select().from(todos).orderBy(asc(todos.id));
  expect(rows).toEqual([{ id: "a", title: "first", done: true }]);
  // Default relations expose every collection to the relational query API.
  expect(await adapter.queryBuilder.query.todos.findMany()).toEqual([
    { id: "a", title: "first", done: true },
  ]);
  await expect(dbStorage.exec({ sql: "BEGIN", params: [], method: "run" })).rejects.toBeInstanceOf(
    TransactionStatementError,
  );

  // Reading through the adapter (not the transaction) waits for the commit, so it never
  // sees the transaction's uncommitted rows.
  let outside: Promise<unknown> | undefined;
  await adapter.transaction(async (tx: any, { native }: any) => {
    await tx.insert("todos", { id: "d", title: "inside" });
    outside = adapter.getOptional("todos", "d");
    // The local-change store joins the transaction through its native handle.
    expect(
      await adapter.localChangeStore.getPendingEvents(
        { collection: "todos", recordId: "a" },
        native,
      ),
    ).toHaveLength(2);
  });
  expect(await outside).toMatchObject({ title: "inside" });

  await client.dispose();
}

test("sql.js storage through drizzle-orm/sqlite-proxy", async () => {
  const dbStorage = createLocalDBStorage({
    dialect: "sqlite",
    open: async () => {
      const engine = await openSqlJsEngine();
      await engine.exec(run(sqliteSchema));
      return engine;
    },
  });
  const collection = defineDrizzleCollection({ name: "todos", table: sqliteTodos });
  const adapter = createDrizzleSqliteDBAdapter({
    dbStorage,
    collections: [collection],
  });
  await exerciseAdapter(adapter, dbStorage, sqliteTodos, collection);
});

test("PGlite storage through drizzle-orm/pg-proxy", async () => {
  const dbStorage = createLocalDBStorage({
    dialect: "postgres",
    open: async () => {
      const engine = await openPGliteEngine();
      await engine.exec(run(pgSchema));
      return engine;
    },
  });
  const collection = defineDrizzleCollection({ name: "todos", table: pgTodos, primaryField: "id" });
  const adapter = createDrizzlePgDBAdapter({
    dbStorage,
    collections: [collection],
  });
  await exerciseAdapter(adapter, dbStorage, pgTodos, collection);
}, 30_000);

test("sqlite-proxy executors map Drizzle calls onto storage queries", async () => {
  const exec = vi.fn(async (_query: DBQuery) => ({ rows: [["row"]] as unknown[] }));
  const executors = sqliteProxyExecutors({ exec });
  expect(await executors.all("select 1", [1], "object")).toEqual([["row"]]);
  expect(await executors.get("select 2", [2])).toEqual(["row"]);
  await executors.run("delete", [3]);
  expect(exec.mock.calls.map(([query]) => query)).toEqual([
    { sql: "select 1", params: [1], method: "all", rowMode: "object" },
    { sql: "select 2", params: [2], method: "get", rowMode: undefined },
    { sql: "delete", params: [3], method: "run" },
  ]);
});

test("custom relations and Drizzle options reach the query builder", async () => {
  const notes = sqliteTable("notes", {
    id: text("id").primaryKey(),
    todoId: text("todoId").notNull(),
    body: text("body").notNull(),
  });
  const relations = defineRelations({ todos: sqliteTodos, notes }, (r) => ({
    todos: { notes: r.many.notes({ from: r.todos.id, to: r.notes.todoId }) },
  }));
  const logQuery = vi.fn();
  const dbStorage = createLocalDBStorage({
    dialect: "sqlite",
    open: async () => {
      const engine = await openSqlJsEngine();
      await engine.exec(run(sqliteSchema));
      return engine;
    },
  });
  const adapter = createDrizzleSqliteDBAdapter({
    dbStorage,
    collections: [defineDrizzleCollection({ name: "todos", table: sqliteTodos })],
    relations,
    drizzleConfig: { logger: { logQuery } },
  });
  await adapter.insert("todos", { id: "a", title: "first" });
  await adapter.queryBuilder.insert(notes).values({ id: "n", todoId: "a", body: "note" });
  expect(await adapter.queryBuilder.query.todos.findMany({ with: { notes: true } })).toEqual([
    { id: "a", title: "first", done: false, notes: [{ id: "n", todoId: "a", body: "note" }] },
  ]);
  expect(logQuery).toHaveBeenCalled();
  await dbStorage.close();
});

test("the adapter rejects a storage of another dialect", () => {
  const dbStorage = createLocalDBStorage({
    dialect: "postgres",
    open: () => ({ exec: async () => ({ rows: [] }), close: async () => {} }),
  });
  expect(() =>
    createDrizzleSqliteDBAdapter({
      dbStorage,
      collections: [defineDrizzleCollection({ name: "todos", table: sqliteTodos })],
    }),
  ).toThrow("built for sqlite but the storage speaks postgres");
});

test("adapters keep caller-supplied codecs", () => {
  const storage = (dialect: "sqlite" | "postgres") =>
    createLocalDBStorage({
      dialect,
      open: () => ({ exec: async () => ({ rows: [] }), close: async () => {} }),
    });
  const codecs = {} as never;
  expect(
    createDrizzleSqliteDBAdapter({
      dbStorage: storage("sqlite"),
      collections: [defineDrizzleCollection({ name: "todos", table: sqliteTodos })],
      drizzleConfig: { codecs },
    }).queryBuilder,
  ).toBeDefined();
  expect(
    createDrizzlePgDBAdapter({
      dbStorage: storage("postgres"),
      collections: [defineDrizzleCollection({ name: "todos", table: pgTodos, primaryField: "id" })],
      drizzleConfig: { codecs },
    }).queryBuilder,
  ).toBeDefined();
});

test("predefined dirty-record tables are unique per collection and record", () => {
  for (const config of [
    getSqliteTableConfig(sqliteLocalChangeTables.dirtyRecords),
    getPgTableConfig(pgLocalChangeTables.dirtyRecords),
  ]) {
    const [index] = config.indexes;
    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns.map((column: any) => column.name)).toEqual([
      "collection",
      "recordId",
    ]);
  }
});

test("predefined event tables index pending events by collection, then seq or record", () => {
  for (const config of [
    getSqliteTableConfig(sqliteLocalChangeTables.events),
    getPgTableConfig(pgLocalChangeTables.events),
  ]) {
    expect(config.columns.find((column) => column.name === "seq")?.primary).toBe(true);
    expect(
      config.indexes.map((index) => [
        index.config.name,
        index.config.columns.map((column: any) => column.name),
      ]),
    ).toEqual([
      ["ez_sync_events_collection_seq", ["collection", "seq"]],
      ["ez_sync_events_record", ["collection", "recordId"]],
    ]);
  }
});

test("predefined applied-event tables are keyed by event id and pruned by appliedAt", () => {
  for (const config of [
    getSqliteTableConfig(sqliteLocalChangeTables.appliedEvents),
    getPgTableConfig(pgLocalChangeTables.appliedEvents),
  ]) {
    expect(config.columns.find((column) => column.name === "eventId")?.primary).toBe(true);
    expect(
      config.indexes.map((index) => [
        index.config.name,
        index.config.columns.map((column: any) => column.name),
      ]),
    ).toEqual([["ez_sync_applied_events_applied_at", ["appliedAt"]]]);
  }
});

test("predefined checkpoint and skipped-event tables are keyed by collection, then record", () => {
  for (const config of [
    getSqliteTableConfig(sqliteLocalChangeTables.checkpoints),
    getPgTableConfig(pgLocalChangeTables.checkpoints),
  ]) {
    expect(config.name).toBe("ez_sync_checkpoints");
    expect(config.columns.find((column) => column.name === "collection")?.primary).toBe(true);
  }
  for (const config of [
    getSqliteTableConfig(sqliteLocalChangeTables.skippedRemoteEvents),
    getPgTableConfig(pgLocalChangeTables.skippedRemoteEvents),
  ]) {
    expect(config.name).toBe("ez_sync_skipped_remote_events");
    expect(config.primaryKeys.map((key) => key.columns.map((column: any) => column.name))).toEqual([
      ["collection", "recordId"],
    ]);
  }
});
