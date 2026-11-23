import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** A text key. */
export const todos = sqliteTable("todos", {
  id: text().primaryKey(),
  title: text().notNull(),
  done: integer().notNull().default(0),
});

/** A number key. */
export const notes = sqliteTable("notes", {
  id: integer().primaryKey(),
  body: text().notNull(),
});

/** A composite key of a text and a number. */
export const pairs = sqliteTable(
  "pairs",
  { a: text().notNull(), b: integer().notNull(), label: text().notNull() },
  (table) => [primaryKey({ columns: [table.a, table.b] })],
);

/** A parent whose members go with it. */
export const groups = sqliteTable("groups", { id: text().primaryKey(), name: text().notNull() });

/** Rows the database deletes when their group is deleted. */
export const members = sqliteTable("members", {
  id: text().primaryKey(),
  groupId: text("group_id")
    .notNull()
    .references(() => groups.id, { onDelete: "cascade" }),
  name: text().notNull(),
});
