import {
  createSyncClient,
  type DBRole,
  type DirtyRecord,
  type InferCollectionInsertModel,
  type InferCollectionPrimaryFieldType,
  type InferCollectionSelectModel,
  type InferCollectionUpdateModel,
  type StoredChangeBusEvent,
} from "@ez-kits/sync-client-core";
import type { DataSource, DeepPartial } from "typeorm";
import { describe, expectTypeOf, test } from "vite-plus/test";
import {
  buildSchemaFromCollections,
  createTypeOrmDBAdapter,
  createTypeOrmLocalChangeStore,
  createTypeOrmDBStorage,
  defineTypeormCollection,
  type TypeOrmDBAdapter,
} from "../../src";

class Todo {
  id!: number;
  title!: string;
}
class User {
  uid!: string;
  email!: string;
}
class OutboxEvent implements StoredChangeBusEvent {
  id!: string;
  type!: "create" | "update" | "delete";
  collection!: string;
  data!: unknown;
  recordId!: string;
  createdAt!: number;
}
class DirtyRecordEntity implements DirtyRecord {
  collection!: string;
  recordId!: string;
  state!: "dirty" | "deleted";
  updatedAt!: number;
}

declare const db: DataSource;
const entities = { eventEntity: OutboxEvent, dirtyRecordEntity: DirtyRecordEntity };

const todoCollection = defineTypeormCollection({ name: "todos", entity: Todo, primaryField: "id" });
const userCollection = defineTypeormCollection({
  name: "users",
  entity: User,
  primaryField: "uid",
});
const collections: [typeof todoCollection, typeof userCollection] = [
  todoCollection,
  userCollection,
];

describe("defineTypeormCollection", () => {
  test("infers name, models and primary key from the entity", () => {
    type TodoConfig = typeof todoCollection;
    expectTypeOf(todoCollection.name).toEqualTypeOf<"todos">();
    expectTypeOf(todoCollection.primaryField).toEqualTypeOf<"id">();
    expectTypeOf(todoCollection.adapterConfig.entity).toEqualTypeOf<typeof Todo>();
    expectTypeOf<InferCollectionSelectModel<TodoConfig>>().toEqualTypeOf<Todo>();
    expectTypeOf<InferCollectionInsertModel<TodoConfig>>().toEqualTypeOf<DeepPartial<Todo>>();
    expectTypeOf<InferCollectionUpdateModel<TodoConfig>>().toEqualTypeOf<Partial<Todo>>();
    expectTypeOf<InferCollectionPrimaryFieldType<TodoConfig>>().toEqualTypeOf<number>();
    expectTypeOf<InferCollectionPrimaryFieldType<typeof userCollection>>().toEqualTypeOf<string>();
  });

  test("rejects primary fields that are not entity properties", () => {
    // @ts-expect-error primary field must be a property of the entity
    defineTypeormCollection({ name: "todos", entity: Todo, primaryField: "missing" });
  });
});

describe("typeorm adapter", () => {
  test("buildSchemaFromCollections maps names to entities", () => {
    expectTypeOf(buildSchemaFromCollections(collections)).toEqualTypeOf<{
      todos: typeof Todo;
      users: typeof User;
    }>();
  });

  test("createTypeOrmDBAdapter exposes the data source and schema", () => {
    const adapter = createTypeOrmDBAdapter({ db, collections, ...entities });
    expectTypeOf(adapter).toEqualTypeOf<
      TypeOrmDBAdapter<typeof collections, DataSource, { todos: typeof Todo; users: typeof User }>
    >();
    expectTypeOf(adapter.queryBuilder).toEqualTypeOf<DataSource>();
    expectTypeOf(adapter.get("users", "u1")).resolves.toEqualTypeOf<User>();
    // @ts-expect-error todos are keyed by numeric id
    void adapter.get("todos", "1");
    // @ts-expect-error a data source is required
    createTypeOrmDBAdapter({ db: {}, collections, ...entities });
  });

  test("the adapter is accepted by createSyncClient", () => {
    expectTypeOf(createTypeOrmDBStorage(db).role).toEqualTypeOf<DBRole>();
    // @ts-expect-error the outbox entities are required
    createTypeOrmDBAdapter({ db, collections });
    const client = createSyncClient({
      collections,
      dbAdapter: createTypeOrmDBAdapter({ db, collections, ...entities }),
      checkpointStorage: {
        getCheckpoint: async () => undefined,
        saveCheckpoint: async () => {},
      },
    });
    expectTypeOf(client.collections.todos.get(1)).resolves.toEqualTypeOf<Todo>();
    client.liveQuery({
      query: (qb, schema) => {
        expectTypeOf(qb).toEqualTypeOf<DataSource>();
        expectTypeOf(schema.users).toEqualTypeOf<typeof User>();
      },
      onData: () => {},
    });
  });

  test("local-change entities must persist every stored field", () => {
    createTypeOrmLocalChangeStore({
      db,
      eventEntity: OutboxEvent,
      dirtyRecordEntity: DirtyRecordEntity,
    });
    createTypeOrmLocalChangeStore({
      db,
      // @ts-expect-error event entity omits persisted event fields
      eventEntity: class {},
      dirtyRecordEntity: DirtyRecordEntity,
    });

    class TextPayloadEvent {
      id!: string;
      type!: "create" | "update" | "delete";
      collection!: string;
      data!: string;
      recordId!: string;
      createdAt!: number;
    }
    // @ts-expect-error event data must accept all local event payloads
    createTypeOrmDBAdapter({
      db,
      collections,
      eventEntity: TextPayloadEvent,
      dirtyRecordEntity: DirtyRecordEntity,
    });
  });
});
