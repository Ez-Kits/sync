import { describe, expectTypeOf, test } from "vite-plus/test";
import type {
  ChangeBusEvent,
  ChangeBusEventDataMapFromCollectionConfigMap,
  CollectionNames,
  CollectionUpdateModel,
  ConfigForName,
  InferCheckpointMap,
  InferCollectionCheckpoint,
  InferCollectionInsertModel,
  InferCollectionPrimaryFieldType,
  InferCollectionSelectModel,
  InferCollectionUpdateModel,
  PrimaryKeyFields,
  PrimaryKeyValue,
  TCollectionRuntime,
  TCollectionRuntimeRecord,
} from "../../src";
import type {
  Checkpoint,
  Collections,
  ItemConfig,
  ItemInsert,
  ItemKey,
  ItemSelect,
  TodoConfig,
  TodoInsert,
  TodoSelect,
  TodoUpdate,
  UserConfig,
  UserSelect,
} from "./fixtures";

describe("collection config inference", () => {
  test("collection names resolve to the literal union", () => {
    expectTypeOf<CollectionNames<Collections>>().toEqualTypeOf<"todos" | "users">();
  });

  test("ConfigForName selects the matching config", () => {
    expectTypeOf<ConfigForName<Collections, "todos">>().toEqualTypeOf<TodoConfig>();
    expectTypeOf<ConfigForName<Collections, "users">>().toEqualTypeOf<UserConfig>();
  });

  test("model helpers extract each model exactly", () => {
    expectTypeOf<InferCollectionInsertModel<TodoConfig>>().toEqualTypeOf<TodoInsert>();
    expectTypeOf<InferCollectionUpdateModel<TodoConfig>>().toEqualTypeOf<TodoUpdate>();
    expectTypeOf<InferCollectionSelectModel<TodoConfig>>().toEqualTypeOf<TodoSelect>();
    expectTypeOf<InferCollectionSelectModel<UserConfig>>().toEqualTypeOf<UserSelect>();
  });

  test("primary field type follows the configured key", () => {
    expectTypeOf<InferCollectionPrimaryFieldType<TodoConfig>>().toEqualTypeOf<number>();
    expectTypeOf<InferCollectionPrimaryFieldType<UserConfig>>().toEqualTypeOf<string>();
  });

  test("checkpoint types are preserved", () => {
    expectTypeOf<InferCollectionCheckpoint<TodoConfig>>().toEqualTypeOf<Checkpoint>();
    expectTypeOf<InferCheckpointMap<Collections>>().toEqualTypeOf<Checkpoint>();
  });
});

describe("collection runtime", () => {
  test("runtime record is keyed by collection name", () => {
    expectTypeOf<keyof TCollectionRuntimeRecord<Collections>>().toEqualTypeOf<"todos" | "users">();
    expectTypeOf<TCollectionRuntimeRecord<Collections>["todos"]>().toEqualTypeOf<
      TCollectionRuntime<TodoConfig>
    >();
  });

  test("runtime methods use the collection models", () => {
    type Todos = TCollectionRuntime<TodoConfig>;
    expectTypeOf<Todos["insert"]>().parameter(0).toEqualTypeOf<TodoInsert>();
    expectTypeOf<Todos["update"]>().parameter(0).toEqualTypeOf<TodoUpdate>();
    expectTypeOf<Todos["delete"]>().parameter(0).toEqualTypeOf<number>();
    expectTypeOf<Todos["upsert"]>().parameter(0).toEqualTypeOf<TodoInsert>();
    expectTypeOf<Todos["insertMany"]>().parameter(0).toEqualTypeOf<readonly TodoInsert[]>();
    expectTypeOf<Todos["updateMany"]>().parameter(0).toEqualTypeOf<readonly TodoUpdate[]>();
    expectTypeOf<Todos["upsertMany"]>().parameter(0).toEqualTypeOf<readonly TodoInsert[]>();
    expectTypeOf<Todos["deleteMany"]>().parameter(0).toEqualTypeOf<readonly number[]>();
    expectTypeOf<Todos["get"]>().returns.resolves.toEqualTypeOf<TodoSelect>();
    expectTypeOf<Todos["getMany"]>().returns.resolves.toEqualTypeOf<TodoSelect[]>();
  });
});

describe("composite primary keys", () => {
  type Items = TCollectionRuntime<ItemConfig>;
  type Key = readonly ["listId", "position"];

  test("key helpers name the fields and build the key value", () => {
    expectTypeOf<PrimaryKeyFields<"id">>().toEqualTypeOf<"id">();
    expectTypeOf<PrimaryKeyFields<Key>>().toEqualTypeOf<"listId" | "position">();
    expectTypeOf<PrimaryKeyValue<TodoSelect, "id">>().toEqualTypeOf<number>();
    expectTypeOf<PrimaryKeyValue<ItemSelect, Key>>().toEqualTypeOf<ItemKey>();
    expectTypeOf<InferCollectionPrimaryFieldType<ItemConfig>>().toEqualTypeOf<ItemKey>();
  });

  test("update requires every key field and leaves the rest optional", () => {
    expectTypeOf<CollectionUpdateModel<TodoInsert, TodoSelect, "id">>().toEqualTypeOf<{
      id: number;
      title?: string;
      done?: boolean;
    }>();
    expectTypeOf<CollectionUpdateModel<ItemInsert, ItemSelect, Key>>().toEqualTypeOf<{
      listId: string;
      position: number;
      label?: string;
      done?: boolean;
    }>();
  });

  test("runtime methods take the key object", () => {
    expectTypeOf<Items["delete"]>().parameter(0).toEqualTypeOf<ItemKey>();
    expectTypeOf<Items["get"]>().parameter(0).toEqualTypeOf<ItemKey>();
    expectTypeOf<Items["deleteMany"]>().parameter(0).toEqualTypeOf<readonly ItemKey[]>();
    expectTypeOf<Items["get"]>().returns.resolves.toEqualTypeOf<ItemSelect>();
  });

  test("calls without the whole key do not compile", () => {
    const items = {} as Items;
    const todos = {} as TCollectionRuntime<TodoConfig>;
    void items.update({ listId: "l1", position: 1, done: true });
    void todos.update({ id: 1, done: true });
    // @ts-expect-error update needs every key field
    void items.update({ listId: "l1", done: true });
    // @ts-expect-error update needs the single key too
    void todos.update({ done: true });
    // @ts-expect-error a composite key is an object
    void items.delete("l1");
    // @ts-expect-error a partial key is not a key
    void items.get({ listId: "l1" });
  });

  test("delete events carry the key object", () => {
    type Event = Extract<
      ChangeBusEvent<ChangeBusEventDataMapFromCollectionConfigMap<[ItemConfig]>, "items">,
      { type: "delete" }
    >;
    expectTypeOf<Event["id"]>().toEqualTypeOf<ItemKey>();
  });
});
