import { createLocalDBStorage, createSyncClient, type DBStorage } from "@ez-kits/sync-client-core";
import { openPGliteEngine } from "@ez-kits/sync-client-storage-pglite/worker";
import { openSqlJsEngine } from "@ez-kits/sync-client-storage-sqljs/worker";
import { pgTable, text as pgText } from "drizzle-orm/pg-core";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { expect, test } from "vite-plus/test";
import { defineDrizzleCollection } from "../src/collection";
import { createDrizzlePgDBAdapter } from "../src/pg";
import { createDrizzleSqliteDBAdapter } from "../src/sqlite";

const run = (sql: string) => ({ sql, params: [], method: "run" as const });
const SCHEMA =
  "CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT); CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT);";

const sqliteColumns = () => ({ id: text("id").primaryKey(), title: text("title") });
const pgColumns = () => ({ id: pgText("id").primaryKey(), title: pgText("title") });
const sqliteTodos = sqliteTable("todos", sqliteColumns());
const sqliteNotes = sqliteTable("notes", sqliteColumns());
const pgTodos = pgTable("todos", pgColumns());
const pgNotes = pgTable("notes", pgColumns());

const dialects = [
  {
    name: "sql.js",
    duplicate: /UNIQUE constraint failed/,
    client: () => {
      const dbStorage = createLocalDBStorage({
        dialect: "sqlite",
        open: async () => {
          const engine = await openSqlJsEngine();
          await engine.exec(run(SCHEMA));
          return engine;
        },
      });
      const collections = [
        defineDrizzleCollection({ name: "todos", table: sqliteTodos }),
        defineDrizzleCollection({ name: "notes", table: sqliteNotes }),
      ];
      return build(
        dbStorage,
        collections,
        createDrizzleSqliteDBAdapter({ dbStorage, collections }),
      );
    },
  },
  {
    name: "PGlite",
    duplicate: /duplicate key/,
    client: () => {
      const dbStorage = createLocalDBStorage({
        dialect: "postgres",
        open: async () => {
          const engine = await openPGliteEngine();
          await engine.exec(run(SCHEMA));
          return engine;
        },
      });
      const collections = [
        defineDrizzleCollection({ name: "todos", table: pgTodos }),
        defineDrizzleCollection({ name: "notes", table: pgNotes }),
      ];
      // Two Postgres collections in one array do not type-check yet (also on main): cast.
      const dbAdapter = createDrizzlePgDBAdapter({ dbStorage, collections: collections as never });
      return build(dbStorage, collections, dbAdapter);
    },
  },
];

function build(dbStorage: DBStorage, collections: readonly unknown[], dbAdapter: any) {
  const client = createSyncClient({
    collections,
    dbAdapter,
    syncAdapter: { push: async () => {}, pull: () => () => {} },
  } as never) as any;
  const rows = async (table: string) =>
    (
      await dbStorage.exec({
        sql: `SELECT id, title FROM ${table} ORDER BY id`,
        params: [],
        method: "all",
        rowMode: "object",
      })
    ).rows;
  const pending = async () =>
    (await dbAdapter.localChangeStore.getPendingEvents()).map(
      (e: any) => `${e.collection}:${e.type}:${e.recordId}`,
    );
  return { client, rows, pending };
}

for (const dialect of dialects) {
  test(`${dialect.name}: insert of an existing id rejects with the database's error and writes nothing`, async () => {
    const { client, rows, pending } = dialect.client();
    await client.collections.todos.insert({ id: "1", title: "a" });
    await expect(client.collections.todos.insert({ id: "1", title: "b" })).rejects.toMatchObject({
      cause: { message: expect.stringMatching(dialect.duplicate) },
    });
    expect(await rows("todos")).toEqual([{ id: "1", title: "a" }]);
    expect(await pending()).toEqual(["todos:create:1"]);
    await client.dispose();
  });

  test(`${dialect.name}: upsert creates, then updates only the given fields`, async () => {
    const { client, rows, pending } = dialect.client();
    await client.collections.todos.upsert({ id: "me", title: "a" });
    await client.collections.todos.upsertMany([
      { id: "me", title: "b" },
      { id: "2", title: "c" },
    ]);
    expect(await rows("todos")).toEqual([
      { id: "2", title: "c" },
      { id: "me", title: "b" },
    ]);
    expect(await pending()).toEqual(["todos:create:me", "todos:update:me", "todos:create:2"]);
    await client.dispose();
  });

  test(`${dialect.name}: a failing record rolls back its whole bulk write`, async () => {
    const { client, rows, pending } = dialect.client();
    await client.collections.todos.insert({ id: "2" });
    await expect(
      client.collections.todos.insertMany([{ id: "1" }, { id: "2" }, { id: "3" }]),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(dialect.duplicate) } });
    expect(await rows("todos")).toEqual([{ id: "2", title: null }]);
    expect(await pending()).toEqual(["todos:create:2"]);

    await client.collections.todos.insertMany(
      Array.from({ length: 300 }, (_, i) => ({ id: `r${i}` })),
    );
    await client.collections.todos.deleteMany(["2", "r0"]);
    expect(await rows("todos")).toHaveLength(299);
    expect(await pending()).toHaveLength(303);
    await client.dispose();
  });

  test(`${dialect.name}: a transaction across collections commits together or not at all`, async () => {
    const { client, rows, pending } = dialect.client();
    await client.collections.todos.insert({ id: "s1", title: "active" });
    await expect(
      client.transaction(async (tx: any) => {
        await tx.collections.todos.update({ id: "s1", title: "done" });
        await tx.collections.notes.insert({ id: "m1" });
        throw new Error("tab closed");
      }),
    ).rejects.toThrow("tab closed");
    expect(await rows("todos")).toEqual([{ id: "s1", title: "active" }]);
    expect(await rows("notes")).toEqual([]);

    const seen = await client.transaction(async (tx: any) => {
      await tx.collections.todos.update({ id: "s1", title: "done" });
      await tx.collections.notes.insert({ id: "m1", title: "chapter" });
      return (await tx.collections.todos.get("s1")).title;
    });
    expect(seen).toBe("done");
    expect(await rows("notes")).toEqual([{ id: "m1", title: "chapter" }]);
    expect(await pending()).toEqual(["todos:create:s1", "todos:update:s1", "notes:create:m1"]);
    await client.dispose();
  });
}
