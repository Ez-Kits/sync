import { expect, test, vi } from "vite-plus/test";
import { getColumns } from "drizzle-orm";
import { integer, primaryKey, SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
const revisions = sqliteTable("revisions", {
  collection: text("collection").notNull(),
  recordId: text("record_id").notNull(),
  rev: integer("rev").notNull(),
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
  });

  expect(dbStorage.transaction).toHaveBeenCalledOnce();
  expect(transactionContext.native).toBe(db);
  expect(callbackOrder).toEqual(["mutate", "outbox"]);
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
    tables: { events, appliedEvents, checkpoints, skippedRemoteEvents, revisions },
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
  await store.saveCheckpoint("todos", "c1", nativeTransaction);

  expect(store.atomicLocalMutationCapability).toBe("atomic");
  expect(store).toMatchObject({ initialize });
  expect(transactionInsert).toHaveBeenCalledTimes(3);
  expect(rootInsert).not.toHaveBeenCalled();
});

test("Drizzle local-change store queries and deletes events", async () => {
  const events = sqliteTable("outbox_queries", {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    type: text("type"),
    collection: text("collection"),
    data: text("data", { mode: "json" }),
    recordId: text("record_id"),
    createdAt: integer("created_at"),
  });
  const eventRows = [{ id: "event", collection: "todos", createdAt: 1 }];
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
        from: () => {
          queryCalls.push(["from", label]);
          return queryFor(eventRows);
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
    tables: { events, appliedEvents, checkpoints, skippedRemoteEvents, revisions },
    initialize,
  });

  await store.appendEvents([]);
  await store.deleteEvents([]);
  await expect(store.getPendingEvents("todos")).resolves.toEqual(eventRows);
  await expect(store.getPendingEvents()).resolves.toEqual(eventRows);
  await store.deleteEvents(["event"]);

  expect(queryCalls.map(([kind]) => kind)).toEqual(["from", "where", "orderBy", "from", "orderBy"]);
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
  expect(deletes).toHaveLength(1);
  expect(deletes[0]?.slice(0, 2)).toEqual(["root", events]);

  // Every method, reads included, runs on a transaction handle it is given.
  queryCalls.length = 0;
  deletes.length = 0;
  const key = { collection: "todos", recordId: "1" };
  await store.getPendingEvents(key, tx);
  await store.deleteEvents(["event"], tx);
  expect(queryCalls.filter(([kind]) => kind === "from")).toEqual([["from", "tx"]]);
  expect(deletes.map(([label]) => label)).toEqual(["tx"]);
  expect(db.select).toHaveBeenCalledTimes(2);
  expect(db.delete).toHaveBeenCalledTimes(1);
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
  const onDuplicateKeyUpdate = vi.fn();
  const duplicateStore = createDrizzleLocalChangeStore({
    db: {
      insert: () => ({
        values: () => ({ onDuplicateKeyUpdate }),
      }),
    },
    tables: { events, appliedEvents, checkpoints, skippedRemoteEvents, revisions },
    initialize,
  });
  const revision = { collection: "todos", recordId: "1", rev: 1 };
  await duplicateStore.upsertRevision(revision);
  expect(onDuplicateKeyUpdate).toHaveBeenCalledWith({ set: { rev: 1 } });

  const unsupportedStore = createDrizzleLocalChangeStore({
    db: { insert: () => ({ values: () => ({}) }) },
    tables: { events, appliedEvents, checkpoints, skippedRemoteEvents, revisions },
    initialize,
  });
  await expect(unsupportedStore.upsertRevision(revision)).rejects.toThrow(
    "does not support local-change upserts",
  );
});

test("Drizzle local-change tables reject incomplete row schemas at type level", () => {
  const { db } = makeDb();
  const invalidEvents = sqliteTable("invalid_events", {
    id: text("id").primaryKey(),
    collection: text("collection"),
  });

  createDrizzleLocalChangeStore({
    db,
    tables: {
      // @ts-expect-error event table omits persisted event columns
      events: invalidEvents,
      appliedEvents,
      checkpoints,
      skippedRemoteEvents,
      revisions,
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
      appliedEvents,
      checkpoints,
      skippedRemoteEvents,
      revisions,
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
    'has a single primary field "id": pass its value, not an object',
  );
  await expect(adapter.delete("todos" as never, { id: 1 } as never)).rejects.toThrow(
    'has a single primary field "id": pass its value, not an object',
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

const items = sqliteTable(
  "items",
  {
    listId: text("listId").notNull(),
    position: integer("position").notNull(),
    label: text("label"),
  },
  (table) => [primaryKey({ columns: [table.listId, table.position] })],
);
const itemsCollection = defineDrizzleCollection({
  name: "items",
  table: items,
  primaryField: ["listId", "position"],
});

test("Drizzle adapter matches composite keys on every key column", async () => {
  const row = { listId: "l1", position: 1, label: "a" };
  const { db, calls } = makeDb([row]);
  const adapter = adapterFor(db, [itemsCollection]);
  const key = { listId: "l1", position: 1 };
  const render = (condition: unknown) => new SQLiteDialect().sqlToQuery(condition as never);
  const byKey = { sql: '(("items"."listId" = ?) and ("items"."position" = ?))', params: ["l1", 1] };

  await adapter.update("items", { ...key, label: "b" });
  await adapter.delete("items", key);
  await expect(adapter.get("items", key)).resolves.toEqual(row);
  await expect(adapter.getOptional!("items", key)).resolves.toEqual(row);
  expect(calls.map((call) => render(call.at(-1)))).toEqual([byKey, byKey, byKey, byKey]);
  expect(calls[0]?.[2]).toEqual({ ...key, label: "b" });

  await expect(adapter.update("items", { listId: "l1", label: "c" } as never)).rejects.toThrow(
    'Update requires primary field "position"',
  );
  await expect(adapter.get("items", "l1" as never)).rejects.toThrow(
    'Collection "items" has a composite primary key ["listId","position"]',
  );
  const empty = adapterFor(makeDb([]).db, [itemsCollection]);
  await expect(empty.get("items", key)).rejects.toThrow(
    'Row not found in "items" for id {"listId":"l1","position":1}',
  );
});
