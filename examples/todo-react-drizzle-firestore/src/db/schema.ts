import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const todos = sqliteTable("todos", {
  id: text().primaryKey(),
  title: text().notNull(),
  completed: integer({ mode: "boolean" }).notNull().default(false),
  updatedAt: integer().notNull(),
});

export const syncEvents = sqliteTable("ez_sync_events", {
  id: text().primaryKey(),
  type: text().notNull(),
  collection: text().notNull(),
  data: text({ mode: "json" }),
  recordId: text().notNull(),
  createdAt: integer().notNull(),
});

export const dirtyRecords = sqliteTable(
  "ez_sync_dirty_records",
  {
    collection: text().notNull(),
    recordId: text().notNull(),
    state: text().notNull(),
    updatedAt: integer().notNull(),
  },
  (table) => [uniqueIndex("ez_sync_dirty_record_key").on(table.collection, table.recordId)],
);

export const schema = {
  todos,
  syncEvents,
  dirtyRecords,
};

export type Todo = typeof todos.$inferSelect;
export type NewTodo = typeof todos.$inferInsert;
