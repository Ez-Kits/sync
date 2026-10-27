import "reflect-metadata";
import { Column, DataSource, Entity, PrimaryColumn, Unique } from "typeorm";
import { expect, test } from "vite-plus/test";
import { createTypeOrmLocalChangeStore } from "../src/create-typeorm-local-change-store";

class OutboxEvent {
  id!: string;
  type!: "create" | "update" | "delete";
  collection!: string;
  data!: unknown;
  recordId!: string;
  createdAt!: number;
}
Entity("ez_sync_events")(OutboxEvent);
PrimaryColumn("text")(OutboxEvent.prototype, "id");
for (const field of ["type", "collection", "recordId"])
  Column("text")(OutboxEvent.prototype, field);
Column("simple-json", { nullable: true })(OutboxEvent.prototype, "data");
Column("integer")(OutboxEvent.prototype, "createdAt");

class DirtyRecordEntity {
  collection!: string;
  recordId!: string;
  state!: "dirty" | "deleted";
  updatedAt!: number;
}
Entity("ez_sync_dirty_records")(DirtyRecordEntity);
Unique(["collection", "recordId"])(DirtyRecordEntity);
PrimaryColumn("text")(DirtyRecordEntity.prototype, "collection");
PrimaryColumn("text")(DirtyRecordEntity.prototype, "recordId");
Column("text")(DirtyRecordEntity.prototype, "state");
Column("integer")(DirtyRecordEntity.prototype, "updatedAt");

test("initialize creates the outbox tables once, without touching other entities", async () => {
  const db = new DataSource({
    type: "sqljs",
    entities: [OutboxEvent, DirtyRecordEntity],
    synchronize: false,
  });
  await db.initialize();
  const store = createTypeOrmLocalChangeStore({
    db,
    eventEntity: OutboxEvent,
    dirtyRecordEntity: DirtyRecordEntity,
  });
  await store.initialize();
  await store.initialize();
  const tables = await db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  expect(tables.map((row: { name: string }) => row.name)).toEqual([
    "ez_sync_dirty_records",
    "ez_sync_events",
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
