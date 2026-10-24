import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const todos = sqliteTable("todos", {
  id: text().primaryKey(),
  title: text().notNull(),
  completed: integer({ mode: "boolean" }).notNull().default(false),
});

export const schema = {
  todos,
};

export type Todo = typeof todos.$inferSelect;
export type NewTodo = typeof todos.$inferInsert;
