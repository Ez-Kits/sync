import {
  createSyncClient,
  type DBStorage,
  type StoredChangeBusEvent,
  type InferCollectionInsertModel,
  type InferCollectionPrimaryFieldType,
  type InferCollectionSelectModel,
  type InferCollectionUpdateModel,
  type TCollectionRuntime,
} from "@ez-kits/sync-client-core";
import type { DeepPartial, EntitySchema, Repository } from "typeorm";
import { describe, expectTypeOf, test } from "vite-plus/test";
import {
  buildSchemaFromCollections,
  defineTypeOrmCollection,
  type TypeOrmDatabase,
  type TypeOrmAppliedEventRow,
  type TypeOrmDBAdapter,
  type TypeOrmEventRow,
  type TypeOrmLocalChangeEntities,
} from "../../src";
import { createTypeOrmPgDBAdapter, pgLocalChangeEntities } from "../../src/pg";
import { createTypeOrmSqliteDBAdapter, sqliteLocalChangeEntities } from "../../src/sqlite";

class Todo {
  id!: number;
  title!: string;
}
class User {
  uid!: string;
  email!: string;
}
class Item {
  listId!: string;
  position!: number;
  label!: string;
}
declare const dbStorage: DBStorage;

const todoCollection = defineTypeOrmCollection({ name: "todos", entity: Todo, primaryField: "id" });
const userCollection = defineTypeOrmCollection({
  name: "users",
  entity: User,
  primaryField: "uid",
});
const itemCollection = defineTypeOrmCollection({
  name: "items",
  entity: Item,
  primaryField: ["listId", "position"],
});
const collections: [typeof todoCollection, typeof userCollection] = [
  todoCollection,
  userCollection,
];

describe("defineTypeOrmCollection", () => {
  test("infers name, models and primary key from the entity", () => {
    type TodoConfig = typeof todoCollection;
    expectTypeOf(todoCollection.name).toEqualTypeOf<"todos">();
    expectTypeOf(todoCollection.primaryField).toEqualTypeOf<"id">();
    expectTypeOf(todoCollection.adapterConfig.entity).toEqualTypeOf<typeof Todo>();
    expectTypeOf<InferCollectionSelectModel<TodoConfig>>().toEqualTypeOf<Todo>();
    expectTypeOf<InferCollectionInsertModel<TodoConfig>>().toEqualTypeOf<DeepPartial<Todo>>();
    expectTypeOf<InferCollectionUpdateModel<TodoConfig>>().toEqualTypeOf<{
      id: number;
      title?: string;
    }>();
    expectTypeOf<InferCollectionPrimaryFieldType<TodoConfig>>().toEqualTypeOf<number>();
    expectTypeOf<InferCollectionPrimaryFieldType<typeof userCollection>>().toEqualTypeOf<string>();
  });

  test("update requires the primary key", () => {
    const todos = {} as TCollectionRuntime<typeof todoCollection>;
    void todos.update({ id: 1, title: "x" });
    // @ts-expect-error update needs the primary key
    void todos.update({ title: "x" });
    // @ts-expect-error the primary key cannot be undefined
    void todos.update({ id: undefined, title: "x" });
  });

  test("a composite key keeps its order and is typed as an object", () => {
    type Items = typeof itemCollection;
    type Key = { listId: string; position: number };
    expectTypeOf(itemCollection.primaryField).toEqualTypeOf<readonly ["listId", "position"]>();
    expectTypeOf<InferCollectionPrimaryFieldType<Items>>().toEqualTypeOf<Key>();
    expectTypeOf<InferCollectionUpdateModel<Items>>().toEqualTypeOf<{
      listId: string;
      position: number;
      label?: string;
    }>();
    const items = {} as TCollectionRuntime<Items>;
    void items.update({ listId: "l1", position: 1, label: "x" });
    void items.delete({ listId: "l1", position: 1 });
    // @ts-expect-error update needs every key field
    void items.update({ listId: "l1", label: "x" });
    // @ts-expect-error a composite key is an object
    void items.delete("l1");
    // @ts-expect-error a partial key is not a key
    void items.get({ position: 1 });
  });

  test("rejects primary fields that are not entity properties", () => {
    // @ts-expect-error primary field must be a property of the entity
    defineTypeOrmCollection({ name: "todos", entity: Todo, primaryField: "missing" });
    // @ts-expect-error every key field must be a property of the entity
    defineTypeOrmCollection({ name: "items", entity: Item, primaryField: ["listId", "missing"] });
    // @ts-expect-error a composite key lists at least one field
    defineTypeOrmCollection({ name: "items", entity: Item, primaryField: [] });
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

describe("outbox entities", () => {
  test("event rows add the database-assigned seq to stored events", () => {
    expectTypeOf<TypeOrmEventRow>().toEqualTypeOf<StoredChangeBusEvent & { seq: number }>();
    expectTypeOf<TypeOrmLocalChangeEntities["events"]>().toEqualTypeOf<
      EntitySchema<TypeOrmEventRow>
    >();
    expectTypeOf(sqliteLocalChangeEntities).toExtend<TypeOrmLocalChangeEntities>();
    expectTypeOf(pgLocalChangeEntities).toExtend<TypeOrmLocalChangeEntities>();
  });

  test("applied-event rows key an event id with the time it is pruned by", () => {
    expectTypeOf<TypeOrmAppliedEventRow>().toEqualTypeOf<{ eventId: string; appliedAt: number }>();
    expectTypeOf<TypeOrmLocalChangeEntities["appliedEvents"]>().toEqualTypeOf<
      EntitySchema<TypeOrmAppliedEventRow>
    >();
  });
});
