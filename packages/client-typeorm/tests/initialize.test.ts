import { DataSource } from "typeorm";
import { expect, test } from "vite-plus/test";
import { createTypeOrmLocalChangeStore } from "../src/core/local-change-store";
import { sqliteLocalChangeEntities } from "../src/sqlite";

test("initialize opens the data source and creates the predefined outbox tables once", async () => {
  const db = new DataSource({
    type: "sqljs",
    entities: Object.values(sqliteLocalChangeEntities),
  });
  const store = createTypeOrmLocalChangeStore(db, sqliteLocalChangeEntities);
  // Opens the data source too.
  await store.initialize();
  await store.initialize();
  const tables = await db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  expect(tables.map((row: { name: string }) => row.name)).toEqual([
    "ez_sync_applied_events",
    "ez_sync_checkpoints",
    "ez_sync_dirty_records",
    "ez_sync_events",
    "ez_sync_meta",
    "ez_sync_skipped_remote_events",
    "sqlite_sequence",
  ]);

  await store.appendEvents([
    { id: "e1", type: "create", collection: "todos", data: { id: 1 }, recordId: "1", createdAt: 1 },
  ]);
  await store.upsertDirtyRecord({
    collection: "todos",
    recordId: "1",
    state: "dirty",
    updatedAt: 1,
  });
  await store.upsertDirtyRecord({
    collection: "todos",
    recordId: "1",
    state: "deleted",
    updatedAt: 2,
  });
  expect(await store.getPendingEvents()).toMatchObject([{ id: "e1", data: { id: 1 } }]);
  expect(await store.getDirtyRecords()).toMatchObject([{ recordId: "1", state: "deleted" }]);
  await db.destroy();
});
