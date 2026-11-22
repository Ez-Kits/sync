import { foreignKey, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** A single-key table whose `createdAt` property maps to a `created_at` column. */
export const lists = sqliteTable("lists", {
  id: text().primaryKey(),
  name: text().notNull(),
  createdAt: integer("created_at").default(0),
});

/** A composite-key table whose rows cascade away with their list. */
export const items = sqliteTable(
  "items",
  {
    listId: text("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    title: text().notNull(),
    done: integer().notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.listId, table.position] })],
);

/** A grandchild of `lists` through a composite foreign key: a list delete cascades two levels. */
export const notes = sqliteTable(
  "notes",
  {
    id: text().primaryKey(),
    listId: text("list_id").notNull(),
    position: integer().notNull(),
    body: text().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.listId, table.position],
      foreignColumns: [items.listId, items.position],
    }).onDelete("cascade"),
  ],
);
