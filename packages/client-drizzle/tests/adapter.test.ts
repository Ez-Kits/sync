import { expect, test, vi } from "vite-plus/test";
import { getColumns } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { buildSchemaFromCollections, defineDrizzleCollection } from "../src/collection";
import { createDrizzleDBAdapter } from "../src/create-drizzle-db-adapter";
import { createDrizzleLocalChangeStore } from "../src/create-drizzle-local-change-store";
import { createDrizzleStorage } from "../src/create-drizzle-storage";

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

test("Drizzle commitLocalMutation uses transaction-bound operations", async () => {
  const { db, calls } = makeDb();
  const adapter = createDrizzleDBAdapter({ db, collections: [collection] } as never);
  const callbackOrder: string[] = [];
  let transactionContext: any;

  await adapter.commitLocalMutation!({
    mutate: async (context) => {
      transactionContext = context;
      callbackOrder.push("mutate");
      const { operations } = context;
      await operations.insert("todos" as never, { id: 9, title: "transactional" } as never);
    },
    persistOutboxEvent: async (context) => {
      expect(context).toBe(transactionContext);
      callbackOrder.push("outbox");
    },
    persistDirtyRecord: async (context) => {
      expect(context).toBe(transactionContext);
      callbackOrder.push("dirty");
    },
  });

  expect(db.transaction).toHaveBeenCalledOnce();
  expect(transactionContext.native).toBe(db);
  expect(callbackOrder).toEqual(["mutate", "outbox", "dirty"]);
  expect(calls).toContainEqual(["insert", todos, { id: 9, title: "transactional" }]);
});

test("Drizzle local-change writes use the transaction handle", async () => {
  const events = sqliteTable("outbox", {
    id: text("id").primaryKey(),
    type: text("type"),
    collection: text("collection"),
    data: text("data", { mode: "json" }),
    recordId: text("record_id"),
    createdAt: integer("created_at"),
  });
  const dirtyRecords = sqliteTable("dirty_records", {
    collection: text("collection"),
    recordId: text("record_id"),
    state: text("state"),
    updatedAt: integer("updated_at"),
  });
  const rootInsert = vi.fn();
  const transactionInsert = vi.fn(() => ({
    values: vi.fn(() => ({ onConflictDoUpdate: vi.fn() })),
  }));
  const store = createDrizzleLocalChangeStore({
    db: { insert: rootInsert },
    tables: { events, dirtyRecords },
  });
  const nativeTransaction = { insert: transactionInsert };
  await store.appendEvents(
    [
      {
        id: "event",
        type: "create",
        collection: "todos",
        data: null,
        recordId: "1",
        createdAt: 1,
      },
    ],
    nativeTransaction,
  );
  await store.upsertDirtyRecord(
    { collection: "todos", recordId: "1", state: "dirty", updatedAt: 1 },
    nativeTransaction,
  );

  expect(store.atomicLocalMutationCapability).toBe("atomic");
  expect(transactionInsert).toHaveBeenCalledTimes(2);
  expect(rootInsert).not.toHaveBeenCalled();

  const storage = createDrizzleStorage({
    db: { insert: rootInsert } as never,
    collections: [collection],
    localChangeTables: { events, dirtyRecords },
  });
  expect(storage.localChangeStore.atomicLocalMutationCapability).toBe("atomic");
  expect(typeof storage.dbAdapter.commitLocalMutation).toBe("function");
});

test("Drizzle local-change store queries and deletes events and dirty records", async () => {
  const events = sqliteTable("outbox_queries", {
    id: text("id").primaryKey(),
    type: text("type"),
    collection: text("collection"),
    data: text("data", { mode: "json" }),
    recordId: text("record_id"),
    createdAt: integer("created_at"),
  });
  const dirtyRecords = sqliteTable("dirty_queries", {
    collection: text("collection"),
    recordId: text("record_id"),
    state: text("state"),
    updatedAt: integer("updated_at"),
  });
  const eventRows = [{ id: "event", collection: "todos", createdAt: 1 }];
  const dirtyRows = [{ collection: "todos", recordId: "1", state: "dirty", updatedAt: 1 }];
  const queryCalls: unknown[][] = [];
  const queryFor = (rows: unknown[]) => {
    let query!: Promise<unknown[]> & {
      where: (condition: unknown) => unknown;
      orderBy: (...columns: unknown[]) => unknown;
    };
    query = Object.assign(Promise.resolve(rows), {
      where: vi.fn((condition: unknown) => {
        queryCalls.push(["where", condition]);
        return query;
      }),
      orderBy: vi.fn((...columns: unknown[]) => {
        queryCalls.push(["orderBy", ...columns]);
        return query;
      }),
    });
    return query;
  };
  const deletes: unknown[][] = [];
  const db = {
    select: vi.fn(() => ({
      from: (table: unknown) => queryFor(table === events ? eventRows : dirtyRows),
    })),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(async (condition: unknown) => {
        deletes.push([table, condition]);
      }),
    })),
  };
  const store = createDrizzleLocalChangeStore({ db, tables: { events, dirtyRecords } });

  await store.appendEvents([]);
  await store.deleteEvents([]);
  await store.removeDirtyRecords([]);
  await expect(store.getPendingEvents("todos")).resolves.toEqual(eventRows);
  await expect(store.getPendingEvents()).resolves.toEqual(eventRows);
  await store.deleteEvents(["event"]);
  await expect(store.getDirtyRecords("todos")).resolves.toEqual(dirtyRows);
  await expect(store.getDirtyRecords()).resolves.toEqual(dirtyRows);
  await store.removeDirtyRecords([{ collection: "todos", recordId: "1" }]);

  expect(queryCalls.map(([kind]) => kind)).toEqual(["where", "orderBy", "orderBy", "where"]);
  expect(queryCalls.filter(([kind]) => kind === "orderBy").every((call) => call.length === 3)).toBe(
    true,
  );
  expect(deletes).toHaveLength(2);
  expect(deletes[0]?.[0]).toBe(events);
  expect(deletes[1]?.[0]).toBe(dirtyRecords);
});

test("Drizzle local-change store supports MySQL upserts and reports unsupported dialects", async () => {
  const events = sqliteTable("outbox_upsert", {
    id: text("id").primaryKey(),
    type: text("type"),
    collection: text("collection"),
    data: text("data", { mode: "json" }),
    recordId: text("record_id"),
    createdAt: integer("created_at"),
  });
  const dirtyRecords = sqliteTable("dirty_upsert", {
    collection: text("collection"),
    recordId: text("record_id"),
    state: text("state"),
    updatedAt: integer("updated_at"),
  });
  const onDuplicateKeyUpdate = vi.fn();
  const duplicateStore = createDrizzleLocalChangeStore({
    db: {
      insert: () => ({
        values: () => ({ onDuplicateKeyUpdate }),
      }),
    },
    tables: { events, dirtyRecords },
  });
  const record = { collection: "todos", recordId: "1", state: "dirty" as const, updatedAt: 1 };
  await duplicateStore.upsertDirtyRecord(record);
  expect(onDuplicateKeyUpdate).toHaveBeenCalledWith({
    set: { state: "dirty", updatedAt: 1 },
  });

  const unsupportedStore = createDrizzleLocalChangeStore({
    db: { insert: () => ({ values: () => ({}) }) },
    tables: { events, dirtyRecords },
  });
  await expect(unsupportedStore.upsertDirtyRecord(record)).rejects.toThrow(
    "does not support dirty-record upserts",
  );
});

test("Drizzle local-change tables reject incomplete row schemas at type level", () => {
  const { db } = makeDb();
  const invalidEvents = sqliteTable("invalid_events", {
    id: text("id").primaryKey(),
    collection: text("collection"),
  });
  const dirtyRecords = sqliteTable("dirty_records", {
    collection: text("collection"),
    recordId: text("record_id"),
    state: text("state"),
    updatedAt: integer("updated_at"),
  });

  // @ts-expect-error event table omits persisted event columns
  createDrizzleLocalChangeStore({ db, tables: { events: invalidEvents, dirtyRecords } });

  const textDataEvents = sqliteTable("text_data_events", {
    id: text("id").primaryKey(),
    type: text("type"),
    collection: text("collection"),
    data: text("data"),
    recordId: text("record_id"),
    createdAt: integer("created_at"),
  });
  // @ts-expect-error arbitrary event payloads require a compatible JSON data column
  createDrizzleLocalChangeStore({ db, tables: { events: textDataEvents, dirtyRecords } });
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
