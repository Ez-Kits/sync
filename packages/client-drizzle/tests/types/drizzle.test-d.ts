import {
  createSyncClient,
  type CollectionNames,
  type DBStorage,
  type InferCollectionInsertModel,
  type InferCollectionPrimaryFieldType,
  type InferCollectionSelectModel,
  type InferCollectionUpdateModel,
} from "@ez-kits/sync-client-core";
import { defineRelations, type InferInsertModel } from "drizzle-orm";
import type { PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expectTypeOf, test } from "vite-plus/test";
import {
  buildRelationsFromCollections,
  buildSchemaFromCollections,
  createDrizzleLocalChangeStore,
  defineDrizzleCollection,
  type BuildRelationsFromCollections,
  type DrizzleDBAdapter,
} from "../../src";
import { createDrizzlePgDBAdapter } from "../../src/pg";
import { createDrizzleSqliteDBAdapter } from "../../src/sqlite";

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
const appliedEvents = sqliteTable("applied_events", {
  eventId: text("event_id").primaryKey(),
  appliedAt: integer("applied_at").notNull(),
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

declare const db: unknown;
declare const dbStorage: DBStorage;
declare const initialize: () => Promise<void>;

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

  test("buildRelationsFromCollections registers every collection table", () => {
    const relations = buildRelationsFromCollections(collections);
    expectTypeOf(relations).toEqualTypeOf<BuildRelationsFromCollections<typeof collections>>();
    expectTypeOf(relations.todos.table).toEqualTypeOf<typeof todos>();
  });

  test("each entry point builds a type-safe Drizzle proxy database", () => {
    type DefaultRelations = BuildRelationsFromCollections<typeof collections>;
    const adapter = createDrizzleSqliteDBAdapter({ dbStorage, collections });
    expectTypeOf(adapter).toEqualTypeOf<
      DrizzleDBAdapter<
        typeof collections,
        SqliteRemoteDatabase<unknown, DefaultRelations>,
        { todos: typeof todos; users: typeof users }
      >
    >();
    expectTypeOf(adapter.querySchema.users).toEqualTypeOf<typeof users>();
    expectTypeOf(adapter.get("todos", 1)).resolves.toHaveProperty("title").toEqualTypeOf<string>();
    expectTypeOf(adapter.queryBuilder.query.users.findFirst()).resolves.toEqualTypeOf<
      { uid: string; email: string } | undefined
    >();
    // @ts-expect-error users are keyed by string uid
    void adapter.get("users", 1);

    const pg = createDrizzlePgDBAdapter({ dbStorage, collections });
    expectTypeOf(pg.queryBuilder).toEqualTypeOf<PgRemoteDatabase<DefaultRelations>>();
    // @ts-expect-error the dialect is chosen by the entry point
    createDrizzleSqliteDBAdapter({ dbStorage, dialect: "sqlite", collections });
    createDrizzleSqliteDBAdapter({
      dbStorage,
      collections,
      // @ts-expect-error relations are configured through `relations`
      drizzleConfig: { relations: {} },
    });
  });

  test("custom relations type the relational query API", () => {
    const relations = defineRelations({ todos, users }, (r) => ({
      users: { todos: r.many.todos() },
      todos: { owner: r.one.users({ from: r.todos.title, to: r.users.uid }) },
    }));
    const dbAdapter = createDrizzleSqliteDBAdapter({
      dbStorage,
      collections,
      relations,
      drizzleConfig: { logger: true },
    });
    expectTypeOf(dbAdapter.queryBuilder).toEqualTypeOf<
      SqliteRemoteDatabase<unknown, typeof relations>
    >();
    expectTypeOf(dbAdapter.dbStorage).toEqualTypeOf<DBStorage>();
    // @ts-expect-error the storage is required
    createDrizzleSqliteDBAdapter({ collections });
    const client = createSyncClient({
      collections,
      dbAdapter,
    });
    expectTypeOf<CollectionNames<typeof collections>>().toEqualTypeOf<"todos" | "users">();
    expectTypeOf(client.collections.users.get("u1")).resolves.toEqualTypeOf<{
      uid: string;
      email: string;
    }>();
    client.liveQuery({
      query: (qb, schema) => {
        expectTypeOf(schema.todos).toEqualTypeOf<typeof todos>();
        return qb.query.users.findMany({ with: { todos: true } });
      },
      onData: (rows) => {
        expectTypeOf(rows[0]!.todos[0]!.title).toEqualTypeOf<string>();
      },
    });
  });

  test("local-change tables must persist every stored field", () => {
    createDrizzleLocalChangeStore({
      db,
      tables: { events, dirtyRecords, appliedEvents, checkpoints, skippedRemoteEvents },
      initialize,
    });
    createDrizzleLocalChangeStore({
      db,
      // @ts-expect-error retries need the applied-event table
      tables: { events, dirtyRecords },
      initialize,
    });
    createDrizzleLocalChangeStore({
      db,
      // @ts-expect-error checkpoints and skipped remote events live with the outbox
      tables: { events, dirtyRecords, appliedEvents },
      initialize,
    });
    const numericCheckpoints = sqliteTable("numeric_checkpoints", {
      collection: text("collection").primaryKey(),
      value: integer("value").notNull(),
    });
    // @ts-expect-error checkpoints are stored serialized, as text
    createDrizzleLocalChangeStore({
      db,
      tables: {
        events,
        dirtyRecords,
        appliedEvents,
        checkpoints: numericCheckpoints,
        skippedRemoteEvents,
      },
      initialize,
    });
    const textSkippedEvents = sqliteTable("text_skipped_events", {
      collection: text("collection").notNull(),
      recordId: text("record_id").notNull(),
      event: text("event").notNull(),
    });
    // @ts-expect-error skipped events are JSON: they need a JSON column
    createDrizzleLocalChangeStore({
      db,
      tables: {
        events,
        dirtyRecords,
        appliedEvents,
        checkpoints,
        skippedRemoteEvents: textSkippedEvents,
      },
      initialize,
    });
    const textAppliedEvents = sqliteTable("text_applied_events", {
      eventId: text("event_id").primaryKey(),
      appliedAt: text("applied_at").notNull(),
    });
    // @ts-expect-error applied records are pruned by a numeric `appliedAt`
    createDrizzleLocalChangeStore({
      db,
      tables: {
        events,
        dirtyRecords,
        appliedEvents: textAppliedEvents,
        checkpoints,
        skippedRemoteEvents,
      },
      initialize,
    });

    const invalidEvents = sqliteTable("invalid_events", {
      id: text("id").primaryKey(),
      collection: text("collection"),
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

    const unordered = () => ({
      id: text("id").notNull().unique(),
      type: text("type"),
      collection: text("collection"),
      data: text("data", { mode: "json" }),
      recordId: text("record_id"),
      createdAt: integer("created_at"),
    });
    const unorderedEvents = sqliteTable("unordered_events", unordered());
    createDrizzleLocalChangeStore({
      db,
      tables: {
        // @ts-expect-error pending events are ordered by a `seq` column
        events: unorderedEvents,
        dirtyRecords,
        appliedEvents,
        checkpoints,
        skippedRemoteEvents,
      },
      initialize,
    });

    const callerSequencedEvents = sqliteTable("caller_sequenced_events", {
      ...unordered(),
      seq: integer("seq").notNull(),
    });
    // @ts-expect-error the database assigns `seq`; callers never supply it
    createDrizzleLocalChangeStore({
      db,
      tables: {
        events: callerSequencedEvents,
        dirtyRecords,
        appliedEvents,
        checkpoints,
        skippedRemoteEvents,
      },
      initialize,
    });
  });
});
