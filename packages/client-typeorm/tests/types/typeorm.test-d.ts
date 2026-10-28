import {
  createSyncClient,
  type DBStorage,
  type InferCollectionInsertModel,
  type InferCollectionPrimaryFieldType,
  type InferCollectionSelectModel,
  type InferCollectionUpdateModel,
} from "@ez-kits/sync-client-core";
import type { DeepPartial, Repository } from "typeorm";
import { describe, expectTypeOf, test } from "vite-plus/test";
import {
  buildSchemaFromCollections,
  defineTypeormCollection,
  type TypeOrmDatabase,
  type TypeOrmDBAdapter,
} from "../../src";
import { createTypeOrmPgDBAdapter } from "../../src/pg";
import { createTypeOrmSqliteDBAdapter } from "../../src/sqlite";

class Todo {
  id!: number;
  title!: string;
}
class User {
  uid!: string;
  email!: string;
}
declare const dbStorage: DBStorage;

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

  test("each entry point creates a typed data source", () => {
    type Schema = { todos: typeof Todo; users: typeof User };
    const adapter = createTypeOrmSqliteDBAdapter({ dbStorage, collections });
    expectTypeOf(adapter).toEqualTypeOf<TypeOrmDBAdapter<typeof collections, Schema>>();
    expectTypeOf(adapter.queryBuilder).toEqualTypeOf<TypeOrmDatabase<Schema>>();
    expectTypeOf(adapter.db.repositories.todos).toEqualTypeOf<Repository<Todo>>();
    expectTypeOf(
      adapter.db.repositories.users.findOneBy({ uid: "u1" }),
    ).resolves.toEqualTypeOf<User | null>();
    // @ts-expect-error repositories are typed by entity
    void adapter.db.repositories.users.findOneBy({ email: 1 });
    expectTypeOf(adapter.get("users", "u1")).resolves.toEqualTypeOf<User>();
    // @ts-expect-error todos are keyed by numeric id
    void adapter.get("todos", "1");

    const pg = createTypeOrmPgDBAdapter({
      dbStorage,
      collections,
      entities: [User],
      dataSourceOptions: { logging: true, schema: "public" },
    });
    expectTypeOf(pg.queryBuilder).toEqualTypeOf<TypeOrmDatabase<Schema>>();
    // @ts-expect-error the data source type, driver and entities are set by the adapter
    createTypeOrmSqliteDBAdapter({ dbStorage, collections, dataSourceOptions: { type: "expo" } });
    // @ts-expect-error the storage is required
    createTypeOrmPgDBAdapter({ collections });
  });

  test("the adapter is accepted by createSyncClient and types live queries", () => {
    const client = createSyncClient({
      collections,
      dbAdapter: createTypeOrmSqliteDBAdapter({ dbStorage, collections }),
      checkpointStorage: {
        getCheckpoint: async () => undefined,
        saveCheckpoint: async () => {},
      },
    });
    expectTypeOf(client.collections.todos.get(1)).resolves.toEqualTypeOf<Todo>();
    client.liveQuery({
      query: (qb, schema) => {
        expectTypeOf(schema.users).toEqualTypeOf<typeof User>();
        expectTypeOf(qb.getRepository(schema.users)).toEqualTypeOf<Repository<User>>();
        return qb.repositories.todos.find({ where: { title: "x" } });
      },
      onData: (todos) => expectTypeOf(todos).toEqualTypeOf<Todo[]>(),
    });
  });
});
