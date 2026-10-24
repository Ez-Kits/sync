import { expect, test, vi } from "vite-plus/test";
import { getColumns } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { buildSchemaFromCollections, defineDrizzleCollection } from "../src/collection";
import { createDrizzleDBAdapter } from "../src/create-drizzle-db-adapter";

const todos = sqliteTable("todos", { id: integer("id").primaryKey(), title: text("title") });
const collection = defineDrizzleCollection({ name: "todos", table: todos });

function makeDb(rows: unknown[] = []) {
  const calls: unknown[][] = [];
  const db = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (value: unknown) => {
        calls.push(["insert", table, value]);
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((value: unknown) => ({
        where: vi.fn(async (condition: unknown) => {
          calls.push(["update", table, value, condition]);
        }),
      })),
    })),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(async (condition: unknown) => {
        calls.push(["delete", table, condition]);
      }),
    })),
    select: vi.fn(() => ({
      from: (table: unknown) => {
        const result = Object.assign(Promise.resolve(rows), {
          where: async (condition: unknown) => {
            calls.push(["where", table, condition]);
            return rows;
          },
        });
        return result;
      },
    })),
    transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(db)),
  };
  return { db, calls };
}

test("Drizzle collection infers its primary column and builds the named schema", () => {
  expect(collection.primaryField).toBe("id");
  expect(buildSchemaFromCollections([collection])).toEqual({ todos });
  expect(
    defineDrizzleCollection({ name: "custom", table: todos, primaryField: "title" }).primaryField,
  ).toBe("title");
  expect(() =>
    defineDrizzleCollection({
      name: "missing",
      table: sqliteTable("empty", { title: text("title") }),
    } as never),
  ).toThrow("Primary field not found");
  const legacyTable = sqliteTable("legacy", { id: integer("id").primaryKey() });
  const legacyId = getColumns(legacyTable).id as any;
  Object.defineProperty(legacyId, "primary", { configurable: true, value: undefined });
  Object.defineProperty(legacyId, "_", { configurable: true, value: { isPrimaryKey: true } });
  expect(defineDrizzleCollection({ name: "legacy", table: legacyTable }).primaryField).toBe("id");
  const malformedTable = sqliteTable("malformed", { id: integer("id").primaryKey() });
  Object.defineProperty(getColumns(malformedTable).id as any, "primary", {
    configurable: true,
    value: undefined,
  });
  expect(() =>
    defineDrizzleCollection({ name: "malformed", table: malformedTable } as never),
  ).toThrow("Primary field not found");
});

test("Drizzle adapter executes CRUD, optional reads, schema fallback, and transactions", async () => {
  const { db, calls } = makeDb([{ id: 1, title: "one" }]);
  const adapter = createDrizzleDBAdapter({ db, collections: [collection] } as never);
  expect(adapter.schema.todos).toBe(todos);
  expect(adapter.queryBuilder).toBe(db);
  expect(adapter.querySchema.todos).toBe(todos);
  await adapter.insert("todos" as never, { id: 1, title: "one" } as never);
  await adapter.update("todos" as never, { id: 1, title: "two" } as never);
  await adapter.delete("todos" as never, 1 as never);
  expect(await adapter.get("todos" as never, 1 as never)).toEqual({ id: 1, title: "one" });
  expect(await adapter.get("todos" as never, { id: 1 } as never)).toEqual({ id: 1, title: "one" });
  expect(await adapter.getOptional!("todos" as never, 1 as never)).toEqual({ id: 1, title: "one" });
  expect(await adapter.getMany("todos" as never)).toHaveLength(1);
  await adapter.transaction(async (tx) => tx.insert("todos" as never, { id: 2 } as never));
  expect(calls.map((call) => call[0])).toContain("insert");
  expect(db.transaction).toHaveBeenCalledOnce();
  const explicit = createDrizzleDBAdapter({
    db,
    collections: [collection],
    schema: { todos },
  } as never);
  expect(explicit.schema.todos).toBe(todos);
});

test("Drizzle adapter rejects missing rows, update keys, bad composite fields, and database errors", async () => {
  const { db } = makeDb([]);
  const adapter = createDrizzleDBAdapter({ db, collections: [collection] } as never);
  await expect(adapter.get("todos" as never, 1 as never)).rejects.toThrow(
    'Row not found in "todos"',
  );
  await expect(adapter.getOptional!("todos" as never, 1 as never)).resolves.toBeUndefined();
  await expect(adapter.update("todos" as never, { title: "no id" } as never)).rejects.toThrow(
    "Update requires primary field",
  );
  await expect(adapter.get("todos" as never, { unknown: 1 } as never)).rejects.toThrow(
    "Unknown column: unknown",
  );
  await expect(adapter.get("todos" as never, {} as never)).rejects.toThrow(
    "Composite primary key must not be empty",
  );
  const rejecting = makeDb();
  rejecting.db.insert = vi.fn(() => ({
    values: vi.fn(async () => {
      throw new Error("write failed");
    }),
  })) as never;
  await expect(
    createDrizzleDBAdapter({ db: rejecting.db, collections: [collection] } as never).insert(
      "todos" as never,
      { id: 2 } as never,
    ),
  ).rejects.toThrow("write failed");
  await expect(adapter.get("other" as never, 1 as never)).rejects.toThrow(
    "Unknown collection: other",
  );
});
