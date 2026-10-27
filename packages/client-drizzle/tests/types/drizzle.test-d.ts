import {
  createSyncClient,
  type AtomicLocalChangeStore,
  type CollectionNames,
  type CoordinatedStorage,
  type InferCollectionInsertModel,
  type InferCollectionPrimaryFieldType,
  type InferCollectionSelectModel,
  type InferCollectionUpdateModel,
} from "@ez-kits/sync-client-core";
import type { InferInsertModel } from "drizzle-orm";
import type { SqliteProxyExecutors } from "drizzle-orm/sqlite-proxy";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expectTypeOf, test } from "vite-plus/test";
import {
  buildSchemaFromCollections,
  createDrizzleDBAdapter,
  createDrizzleLocalChangeStore,
  createDrizzleStorage,
  defineDrizzleCollection,
  forwardSqliteProxy,
  type DrizzleDBAdapter,
  type SqliteProxyRequest,
} from "../../src";

const todos = sqliteTable("todos", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
  done: integer("done", { mode: "boolean" }),
});
const users = sqliteTable("users", {
  uid: text("uid").primaryKey(),
  email: text("email").notNull(),
});
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

interface DrizzleDb {
  readonly kind: "drizzle-db";
}
declare const db: DrizzleDb;

const todoCollection = defineDrizzleCollection({ name: "todos", table: todos });
const userCollection = defineDrizzleCollection({ name: "users", table: users });
const collections: [typeof todoCollection, typeof userCollection] = [
  todoCollection,
  userCollection,
];

describe("defineDrizzleCollection", () => {
  test("infers name, models and primary key from the table", () => {
    type Todo = typeof todoCollection;
    expectTypeOf(todoCollection.name).toEqualTypeOf<"todos">();
    expectTypeOf(todoCollection.primaryField).toEqualTypeOf<"id">();
    expectTypeOf(userCollection.primaryField).toEqualTypeOf<"uid">();
    expectTypeOf(todoCollection.adapterConfig.table).toEqualTypeOf<typeof todos>();
    expectTypeOf<InferCollectionSelectModel<Todo>>().toEqualTypeOf<{
      id: number;
      title: string;
      done: boolean | null;
    }>();
    expectTypeOf<InferCollectionInsertModel<Todo>>().toEqualTypeOf<
      InferInsertModel<typeof todos>
    >();
    expectTypeOf<InferCollectionUpdateModel<Todo>>().toEqualTypeOf<
      Partial<InferInsertModel<typeof todos>>
    >();
    expectTypeOf<InferCollectionPrimaryFieldType<Todo>>().toEqualTypeOf<number>();
    expectTypeOf<InferCollectionPrimaryFieldType<typeof userCollection>>().toEqualTypeOf<string>();
  });

  test("rejects primary fields that are not table columns", () => {
    // @ts-expect-error primary field must be a column of the table
    defineDrizzleCollection({ name: "todos", table: todos, primaryField: "missing" });
  });
});

describe("drizzle adapter", () => {
  test("buildSchemaFromCollections maps names to tables", () => {
    expectTypeOf(buildSchemaFromCollections(collections)).toEqualTypeOf<{
      todos: typeof todos;
      users: typeof users;
    }>();
  });

  test("createDrizzleDBAdapter exposes the drizzle db and schema", () => {
    const adapter = createDrizzleDBAdapter({ db, collections });
    expectTypeOf(adapter).toEqualTypeOf<
      DrizzleDBAdapter<typeof collections, DrizzleDb, { todos: typeof todos; users: typeof users }>
    >();
    expectTypeOf(adapter.queryBuilder).toEqualTypeOf<DrizzleDb>();
    expectTypeOf(adapter.querySchema.users).toEqualTypeOf<typeof users>();
    expectTypeOf(adapter.get("todos", 1)).resolves.toHaveProperty("title").toEqualTypeOf<string>();
    // @ts-expect-error users are keyed by string uid
    void adapter.get("users", 1);
  });

  test("createDrizzleStorage produces storage accepted by createSyncClient", () => {
    const storage = createDrizzleStorage({
      collections,
      localChangeTables: { events, dirtyRecords },
      open: () => ({
        database: db,
        execute: async (request: SqliteProxyRequest) => {
          expectTypeOf(request.sql).toEqualTypeOf<string>();
          return [];
        },
      }),
      connect: (send: (request: SqliteProxyRequest) => Promise<unknown>) => {
        expectTypeOf(forwardSqliteProxy(send)).toEqualTypeOf<SqliteProxyExecutors>();
        return db;
      },
    });
    expectTypeOf(storage).toEqualTypeOf<
      CoordinatedStorage<
        DrizzleDBAdapter<
          typeof collections,
          DrizzleDb,
          { todos: typeof todos; users: typeof users }
        >,
        AtomicLocalChangeStore
      >
    >();
    // @ts-expect-error exclusive storage needs a follower connector
    createDrizzleStorage({
      collections,
      localChangeTables: { events, dirtyRecords },
      open: () => ({ database: db, execute: async () => [] }),
    });
    createDrizzleStorage({
      sharing: "shared",
      collections,
      localChangeTables: { events, dirtyRecords },
      open: () => ({ database: db }),
    });
    const client = createSyncClient({
      collections,
      storage,
      checkpointStorage: {
        getCheckpoint: async () => undefined,
        saveCheckpoint: async () => {},
      },
    });
    expectTypeOf<CollectionNames<typeof collections>>().toEqualTypeOf<"todos" | "users">();
    expectTypeOf(client.collections.users.get("u1")).resolves.toEqualTypeOf<{
      uid: string;
      email: string;
    }>();
    client.liveQuery({
      query: (qb, schema) => {
        expectTypeOf(qb).toEqualTypeOf<DrizzleDb>();
        expectTypeOf(schema.todos).toEqualTypeOf<typeof todos>();
      },
      onData: () => {},
    });
  });

  test("local-change tables must persist every stored field", () => {
    createDrizzleLocalChangeStore({ db, tables: { events, dirtyRecords } });

    const invalidEvents = sqliteTable("invalid_events", {
      id: text("id").primaryKey(),
      collection: text("collection"),
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
    createDrizzleStorage({
      sharing: "shared",
      open: () => ({ database: db }),
      collections,
      localChangeTables: { events: textDataEvents, dirtyRecords },
    });
  });
});
