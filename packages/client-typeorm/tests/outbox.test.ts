import "reflect-metadata";
import {
  APPLIED_EVENT_RETENTION_MS,
  createLocalDBStorage,
  type DBStorage,
  type StoredChangeBusEvent,
} from "@ez-kits/sync-client-core";
import { openPGliteEngine } from "@ez-kits/sync-storage-pglite/worker";
import { openSqlJsEngine } from "@ez-kits/sync-storage-sqljs/worker";
import { Column, Entity, PrimaryColumn } from "typeorm";
import { expect, test, vi } from "vite-plus/test";
import { defineTypeormCollection } from "../src/collection";
import { createTypeOrmPgDBAdapter } from "../src/pg";
import { createTypeOrmSqliteDBAdapter } from "../src/sqlite";

class Todo {
  id!: string;
  title!: string;
}
Entity("todos")(Todo);
PrimaryColumn("text")(Todo.prototype, "id");
Column("text", { nullable: true })(Todo.prototype, "title");

const collection = defineTypeormCollection({ name: "todos", entity: Todo, primaryField: "id" });
const run = (sql: string) => ({ sql, params: [], method: "run" as const });
const rowsOf = async (storage: DBStorage, sql: string) =>
  (await storage.exec({ sql, params: [], method: "all", rowMode: "object" })).rows;

/** The outbox tables as version 1 of the TypeORM adapter created them: keyed by `id`, no `seq`. */
const dialects = [
  {
    name: "sql.js",
    v1: `
CREATE TABLE "ez_sync_events" ("id" text PRIMARY KEY NOT NULL, "type" text NOT NULL,
  "collection" text NOT NULL, "data" text, "recordId" text NOT NULL, "createdAt" integer NOT NULL);
CREATE TABLE "ez_sync_dirty_records" ("collection" text NOT NULL, "recordId" text NOT NULL,
  "state" text NOT NULL, "updatedAt" integer NOT NULL, PRIMARY KEY ("collection", "recordId"));`,
    insertV1: `INSERT INTO ez_sync_events (id, type, collection, data, "recordId", "createdAt") VALUES (?, 'update', 'todos', '{"id":"a"}', 'a', ?)`,
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
    v1: `
CREATE TABLE "ez_sync_events" ("id" text NOT NULL, "type" text NOT NULL, "collection" text NOT NULL,
  "data" jsonb, "recordId" text NOT NULL, "createdAt" bigint NOT NULL,
  CONSTRAINT "PK_ez_sync_events_v1" PRIMARY KEY ("id"));
CREATE TABLE "ez_sync_dirty_records" ("collection" text NOT NULL, "recordId" text NOT NULL,
  "state" text NOT NULL, "updatedAt" bigint NOT NULL,
  CONSTRAINT "PK_ez_sync_dirty_records_v1" PRIMARY KEY ("collection", "recordId"));`,
    insertV1: `INSERT INTO ez_sync_events (id, type, collection, data, "recordId", "createdAt") VALUES ($1, 'update', 'todos', '{"id":"a"}', 'a', $2)`,
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
    const recordA = await localChangeStore.getPendingEvents({ collection: "todos", recordId: "a" });
    // `seq` stays internal: events read back have the stored fields only.
    expect(recordA).toEqual([event("z", 5), event("m", 5), event("a", 5)]);
    await db.destroy();
    await dbStorage.close();
  }, 30_000);

  test(`${dialect.name}: initialize migrates version 1 tables once, keeping pending order`, async () => {
    const dbStorage = dialect.storage(dialect.v1);
    for (const [id, createdAt] of [
      ["late", 3],
      ["second", 2],
      ["first-b", 1],
      ["first-a", 1],
    ] as const) {
      await dbStorage.exec({ sql: dialect.insertV1, params: [id, createdAt], method: "run" });
    }
    await dbStorage.exec(
      run(
        `INSERT INTO ez_sync_dirty_records (collection, "recordId", state, "updatedAt") VALUES ('todos', 'a', 'dirty', 1)`,
      ),
    );
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
      { key: "schema_version", value: 4 },
    ]);
    expect(ids(await localChangeStore.getPendingEvents())).toEqual([
      "first-a",
      "first-b",
      "second",
      "late",
    ]);
    expect(await localChangeStore.getDirtyRecords()).toEqual([
      { collection: "todos", recordId: "a", state: "dirty", updatedAt: 1 },
    ]);

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
    const transaction = vi.spyOn(dbStorage, "transaction");
    await localChangeStore.initialize();
    expect(await rowsOf(dbStorage, "SELECT * FROM ez_sync_events ORDER BY seq")).toEqual(snapshot);
    expect(transaction).toHaveBeenCalledOnce();
    await db.destroy();
    await dbStorage.close();
  }, 30_000);

  test(`${dialect.name}: initialize upgrades version 2 tables with the applied-event table`, async () => {
    const dbStorage = dialect.storage("");
    const { db, localChangeStore } = dialect.adapter(dbStorage);
    await localChangeStore.initialize();
    // Back to version 2: no applied-event table, one pending event.
    await localChangeStore.appendEvents([event("pending", 1)]);
    await dbStorage.exec(run("DROP TABLE ez_sync_applied_events"));
    await dbStorage.exec(run("UPDATE ez_sync_meta SET value = 2 WHERE key = 'schema_version'"));

    const otherTab = dialect.adapter(dbStorage);
    await otherTab.localChangeStore.initialize();
    await otherTab.db.destroy();
    expect(await rowsOf(dbStorage, "SELECT key, value FROM ez_sync_meta")).toEqual([
      { key: "schema_version", value: 4 },
    ]);
    expect(ids(await localChangeStore.getPendingEvents())).toEqual(["pending"]);
    await localChangeStore.appendEvents([event("after", 2)]);
    expect(await localChangeStore.hasAppliedEvent("after")).toBe(true);
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
