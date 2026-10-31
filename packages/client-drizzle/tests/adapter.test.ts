import { expect, test, vi } from "vite-plus/test";
import { getColumns } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { buildSchemaFromCollections, defineDrizzleCollection } from "../src/collection";
import { createDrizzleProxyDBAdapter } from "../src/create-drizzle-proxy-db-adapter";
import { createDrizzleLocalChangeStore } from "../src/create-drizzle-local-change-store";

const todos = sqliteTable("todos", { id: integer("id").primaryKey(), title: text("title") });
const collection = defineDrizzleCollection({ name: "todos", table: todos });
const initialize = async () => {};
const appliedEvents = sqliteTable("applied_events", {
  eventId: text("eventId").primaryKey(),
  appliedAt: integer("appliedAt").notNull(),
});
const checkpoints = sqliteTable("checkpoints", {
  collection: text("collection").primaryKey(),
  value: text("value").notNull(),
});
const skippedRemoteEvents = sqliteTable("skipped_remote_events", {
  collection: text("collection").notNull(),
  recordId: text("record_id").notNull(),
  event: text("event", { mode: "json" }).notNull(),
});
/** The storage of the last `adapterFor` call. */
let dbStorage: any;

/** A storage whose transactions run in place; the driver hands back the mock database. */
function adapterFor(db: unknown, collections: unknown[] = [collection]) {
  dbStorage = { dialect: "sqlite", exec: vi.fn() };
  dbStorage.transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(dbStorage));
  return createDrizzleProxyDBAdapter({ dbStorage, collections } as never, {
    dialect: "sqlite",
    createDatabase: () => db,
    createLocalChangeStore: () => ({ atomicLocalMutationCapability: "atomic" }) as never,
  });
}

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
  const adapter = adapterFor(db);
  expect(adapter.schema.todos).toBe(todos);
  expect(adapter.queryBuilder).toBe(db);
  expect(adapter.querySchema.todos).toBe(todos);
  await adapter.insert("todos" as never, { id: 1, title: "one" } as never);
  await adapter.update("todos" as never, { id: 1, title: "two" } as never);
  await adapter.delete("todos" as never, 1 as never);
  expect(await adapter.get("todos" as never, 1 as never)).toEqual({ id: 1, title: "one" });
  expect(await adapter.getOptional!("todos" as never, 1 as never)).toEqual({ id: 1, title: "one" });
  expect(await adapter.getMany("todos" as never)).toHaveLength(1);
  await adapter.transaction(async (tx) => tx.insert("todos" as never, { id: 2 } as never));
  expect(calls.map((call) => call[0])).toContain("insert");
  expect(dbStorage.transaction).toHaveBeenCalledOnce();
  expect(adapter.localChangeStore.atomicLocalMutationCapability).toBe("atomic");
});

test("Drizzle commitLocalMutation uses transaction-bound operations", async () => {
  const { db, calls } = makeDb();
  const adapter = adapterFor(db);
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

  expect(dbStorage.transaction).toHaveBeenCalledOnce();
  expect(transactionContext.native).toBe(db);
  expect(callbackOrder).toEqual(["mutate", "outbox", "dirty"]);
  expect(calls).toContainEqual(["insert", todos, { id: 9, title: "transactional" }]);
});

test("Drizzle local-change writes use the transaction handle", async () => {
  const events = sqliteTable("outbox", {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
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
  const inserted: unknown[] = [];
  const transactionInsert = vi.fn(() => ({
    values: vi.fn((values: unknown) => {
      inserted.push(values);
      return { onConflictDoUpdate: vi.fn() };
    }),
  }));
  const store = createDrizzleLocalChangeStore({
    db: { insert: rootInsert },
    tables: { events, dirtyRecords, appliedEvents, checkpoints, skippedRemoteEvents },
    initialize,
  });
  const pruned: unknown[] = [];
  const transactionDelete = vi.fn((table: unknown) => ({
    where: vi.fn(async () => {
      pruned.push(table);
    }),
  }));
  const nativeTransaction = { insert: transactionInsert, delete: transactionDelete };
  const event = {
    id: "event",
    type: "create" as const,
    collection: "todos",
    data: null,
    recordId: "1",
    createdAt: 1,
  };
  // A `seq` read back with an event never reaches the insert: the database assigns it.
  await store.appendEvents([{ ...event, seq: 7 } as typeof event], nativeTransaction);
  expect(inserted[0]).toEqual([event]);
  // The applied record is pruned and written in the same transaction.
  expect(pruned).toEqual([appliedEvents]);
  expect(inserted[1]).toEqual([{ eventId: "event", appliedAt: 1 }]);
  await store.upsertDirtyRecord(
    { collection: "todos", recordId: "1", state: "dirty", updatedAt: 1 },
    nativeTransaction,
  );

  expect(store.atomicLocalMutationCapability).toBe("atomic");
  expect(store).toMatchObject({ initialize });
  expect(transactionInsert).toHaveBeenCalledTimes(3);
  expect(rootInsert).not.toHaveBeenCalled();
});

test("Drizzle local-change store queries and deletes events and dirty records", async () => {
  const events = sqliteTable("outbox_queries", {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
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
  const selections: unknown[] = [];
  const databaseFor = (label: string) => ({
    select: vi.fn((fields?: unknown) => {
      selections.push(fields);
      return {
        from: (table: unknown) => {
          queryCalls.push(["from", label]);
          return queryFor(table === events ? eventRows : dirtyRows);
        },
      };
    }),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(async (condition: unknown) => {
        deletes.push([label, table, condition]);
      }),
    })),
  });
  const db = databaseFor("root");
  const tx = databaseFor("tx");
  const store = createDrizzleLocalChangeStore({
    db,
    tables: { events, dirtyRecords, appliedEvents, checkpoints, skippedRemoteEvents },
    initialize,
  });

  await store.appendEvents([]);
  await store.deleteEvents([]);
  await store.removeDirtyRecords([]);
  await expect(store.getPendingEvents("todos")).resolves.toEqual(eventRows);
  await expect(store.getPendingEvents()).resolves.toEqual(eventRows);
  await store.deleteEvents(["event"]);
  await expect(store.getDirtyRecords("todos")).resolves.toEqual(dirtyRows);
  await expect(store.getDirtyRecords()).resolves.toEqual(dirtyRows);
  await store.removeDirtyRecords([{ collection: "todos", recordId: "1" }]);

  expect(queryCalls.map(([kind]) => kind)).toEqual([
    "from",
    "where",
    "orderBy",
    "from",
    "orderBy",
    "from",
    "where",
    "from",
  ]);
  // Pending events sort by the database-assigned `seq` alone.
  const seq = getColumns(events).seq;
  for (const call of queryCalls.filter(([kind]) => kind === "orderBy")) {
    expect(call).toHaveLength(2);
    expect((call[1] as any).queryChunks).toContain(seq);
  }
  // `seq` only orders rows; it is never read back.
  expect(Object.keys(selections[0] as object)).toEqual([
    "id",
    "type",
    "collection",
    "data",
    "recordId",
    "createdAt",
  ]);
  expect(deletes).toHaveLength(2);
  expect(deletes[0]?.slice(0, 2)).toEqual(["root", events]);
  expect(deletes[1]?.slice(0, 2)).toEqual(["root", dirtyRecords]);

  // Every method, reads included, runs on a transaction handle it is given.
  queryCalls.length = 0;
  deletes.length = 0;
  const key = { collection: "todos", recordId: "1" };
  await store.getPendingEvents(key, tx);
  await store.getDirtyRecords(key, tx);
  await store.deleteEvents(["event"], tx);
  await store.removeDirtyRecords([key], tx);
  expect(queryCalls.filter(([kind]) => kind === "from")).toEqual([
    ["from", "tx"],
    ["from", "tx"],
  ]);
  expect(deletes.map(([label]) => label)).toEqual(["tx", "tx"]);
  expect(db.select).toHaveBeenCalledTimes(4);
  expect(db.delete).toHaveBeenCalledTimes(2);
});

test("Drizzle local-change store supports MySQL upserts and reports unsupported dialects", async () => {
  const events = sqliteTable("outbox_upsert", {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
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
    tables: { events, dirtyRecords, appliedEvents, checkpoints, skippedRemoteEvents },
    initialize,
  });
  const record = { collection: "todos", recordId: "1", state: "dirty" as const, updatedAt: 1 };
  await duplicateStore.upsertDirtyRecord(record);
  expect(onDuplicateKeyUpdate).toHaveBeenCalledWith({
    set: { state: "dirty", updatedAt: 1 },
  });

  const unsupportedStore = createDrizzleLocalChangeStore({
    db: { insert: () => ({ values: () => ({}) }) },
    tables: { events, dirtyRecords, appliedEvents, checkpoints, skippedRemoteEvents },
    initialize,
  });
  await expect(unsupportedStore.upsertDirtyRecord(record)).rejects.toThrow(
    "does not support local-change upserts",
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

  createDrizzleLocalChangeStore({
    db,
    tables: {
      // @ts-expect-error event table omits persisted event columns
      events: invalidEvents,
      dirtyRecords,
      appliedEvents,
      checkpoints,
      skippedRemoteEvents,
    },
    initialize,
  });

  const textDataEvents = sqliteTable("text_data_events", {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    type: text("type"),
    collection: text("collection"),
    data: text("data"),
    recordId: text("record_id"),
    createdAt: integer("created_at"),
  });
  // @ts-expect-error arbitrary event payloads require a compatible JSON data column
  createDrizzleLocalChangeStore({
    db,
    tables: {
      events: textDataEvents,
      dirtyRecords,
      appliedEvents,
      checkpoints,
      skippedRemoteEvents,
    },
    initialize,
  });
});

test("Drizzle adapter rejects missing rows, update keys, composite keys, and database errors", async () => {
  const { db } = makeDb([]);
  const adapter = adapterFor(db);
  await expect(adapter.get("todos" as never, 1 as never)).rejects.toThrow(
    'Row not found in "todos"',
  );
  await expect(adapter.getOptional!("todos" as never, 1 as never)).resolves.toBeUndefined();
  await expect(adapter.update("todos" as never, { title: "no id" } as never)).rejects.toThrow(
    "Update requires primary field",
  );
  await expect(adapter.get("todos" as never, { id: 1 } as never)).rejects.toThrow(
    "Composite primary keys are not supported",
  );
  await expect(adapter.delete("todos" as never, { id: 1 } as never)).rejects.toThrow(
    "Composite primary keys are not supported",
  );
  const misnamed = adapterFor(db, [{ ...collection, primaryField: "missing" }]);
  await expect(misnamed.get("todos" as never, 1 as never)).rejects.toThrow(
    "Unknown column: missing",
  );
  const rejecting = makeDb();
  rejecting.db.insert = vi.fn(() => ({
    values: vi.fn(async () => {
      throw new Error("write failed");
    }),
  })) as never;
  await expect(
    adapterFor(rejecting.db).insert("todos" as never, { id: 2 } as never),
  ).rejects.toThrow("write failed");
  await expect(adapter.get("other" as never, 1 as never)).rejects.toThrow(
    "Unknown collection: other",
  );
});
