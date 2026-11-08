import "reflect-metadata";
import {
  APPLIED_EVENT_RETENTION_MS,
  createLocalDBStorage,
  type DBStorage,
  type StoredChangeBusEvent,
} from "@ez-kits/sync-client-core";
import { openPGliteEngine } from "@ez-kits/sync-client-storage-pglite/worker";
import { openSqlJsEngine } from "@ez-kits/sync-client-storage-sqljs/worker";
import { Column, Entity, PrimaryColumn } from "typeorm";
import { expect, test, vi } from "vite-plus/test";
import { defineTypeOrmCollection } from "../src/collection";
import { createTypeOrmPgDBAdapter } from "../src/pg";
import { createTypeOrmSqliteDBAdapter } from "../src/sqlite";

class Todo {
  id!: string;
  title!: string;
}
Entity("todos")(Todo);
PrimaryColumn("text")(Todo.prototype, "id");
Column("text", { nullable: true })(Todo.prototype, "title");

const collection = defineTypeOrmCollection({ name: "todos", entity: Todo, primaryField: "id" });
const run = (sql: string) => ({ sql, params: [], method: "run" as const });
const rowsOf = async (storage: DBStorage, sql: string) =>
  (await storage.exec({ sql, params: [], method: "all", rowMode: "object" })).rows;

const dialects = [
  {
    name: "sql.js",
    storage: (schema: string) =>
      createLocalDBStorage({
        dialect: "sqlite",
        open: async () => {
          const engine = await openSqlJsEngine();
          await engine.exec(run(`CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT);${schema}`));
          return engine;
        },
      }),
    adapter: (dbStorage: DBStorage) =>
      createTypeOrmSqliteDBAdapter({ dbStorage, collections: [collection] }),
  },
  {
    name: "PGlite",
    storage: (schema: string) =>
      createLocalDBStorage({
        dialect: "postgres",
        open: async () => {
          const engine = await openPGliteEngine();
          await engine.exec(run(`CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT);${schema}`));
          return engine;
        },
      }),
    adapter: (dbStorage: DBStorage) =>
      createTypeOrmPgDBAdapter({ dbStorage, collections: [collection] }),
  },
];

const event = (id: string, createdAt: number, recordId = "a"): StoredChangeBusEvent => ({
  id,
  type: "update",
  collection: "todos",
  data: { id: recordId },
  recordId,
  createdAt,
});
const ids = (events: StoredChangeBusEvent[]) => events.map(({ id }) => id);

for (const dialect of dialects) {
  test(`${dialect.name}: events of the same millisecond come back in insertion order`, async () => {
    const dbStorage = dialect.storage("");
    const { db, localChangeStore } = dialect.adapter(dbStorage);
    await localChangeStore.initialize();
    await localChangeStore.appendEvents([event("z", 5)]);
    await localChangeStore.appendEvents([event("m", 5), event("b", 5, "b")]);
    await localChangeStore.appendEvents([event("a", 5)]);
    expect(ids(await localChangeStore.getPendingEvents())).toEqual(["z", "m", "b", "a"]);
    // What the client counts: ids and collections only.
    expect(
      (await localChangeStore.getPendingEventKeys!()).sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(["a", "b", "m", "z"].map((id) => ({ id, collection: "todos" })));
    const recordA = await localChangeStore.getPendingEvents({ collection: "todos", recordId: "a" });
    // `seq` stays internal: events read back have the stored fields only.
    expect(recordA).toEqual([event("z", 5), event("m", 5), event("a", 5)]);
    await db.destroy();
    await dbStorage.close();
  }, 30_000);

  test(`${dialect.name}: initialize creates the tables once, and later calls change nothing`, async () => {
    const dbStorage = dialect.storage("");
    const { db, localChangeStore } = dialect.adapter(dbStorage);
    // Another tab: its own data source on the same storage. All initialize together.
    const otherTab = dialect.adapter(dbStorage);
    await Promise.all([
      localChangeStore.initialize(),
      localChangeStore.initialize(),
      otherTab.localChangeStore.initialize(),
    ]);
    await otherTab.db.destroy();
    expect(await rowsOf(dbStorage, "SELECT key, value FROM ez_sync_meta")).toEqual([
      { key: "schema_version", value: 5 },
    ]);
    await localChangeStore.appendEvents([event("pending", 1)]);

    const transaction = vi.spyOn(dbStorage, "transaction");
    await localChangeStore.initialize();
    expect(transaction).toHaveBeenCalledOnce();
    expect(ids(await localChangeStore.getPendingEvents())).toEqual(["pending"]);
    await db.destroy();
    await dbStorage.close();
  }, 30_000);

  test(`${dialect.name}: a version 4 database gets the revisions table and keeps its data`, async () => {
    const dbStorage = dialect.storage("");
    const { db, localChangeStore } = dialect.adapter(dbStorage);
    await localChangeStore.initialize();
    await localChangeStore.appendEvents([event("pending", 1)]);
    await dbStorage.exec({ sql: "DROP TABLE ez_sync_revisions", params: [], method: "run" });
    await dbStorage.exec({
      sql: "UPDATE ez_sync_meta SET value = 4 WHERE key = 'schema_version'",
      params: [],
      method: "run",
    });

    await localChangeStore.initialize();
    const key = { collection: "todos", recordId: "a" };
    await localChangeStore.upsertRevision({ ...key, rev: 2 });
    expect(await localChangeStore.getRevision(key)).toBe(2);
    expect(ids(await localChangeStore.getPendingEvents())).toEqual(["pending"]);
    expect(await rowsOf(dbStorage, "SELECT key, value FROM ez_sync_meta")).toEqual([
      { key: "schema_version", value: 5 },
    ]);
    await db.destroy();
    await dbStorage.close();
  }, 30_000);

  test(`${dialect.name}: applied events outlive their acknowledgement until pruned`, async () => {
    const dbStorage = dialect.storage("");
    const { db, localChangeStore } = dialect.adapter(dbStorage);
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
    await db.destroy();
    await dbStorage.close();
  }, 30_000);
}
