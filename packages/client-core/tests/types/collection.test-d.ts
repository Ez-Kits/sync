import { describe, expectTypeOf, test } from "vite-plus/test";
import type {
  CollectionNames,
  ConfigForName,
  InferCheckpointMap,
  InferCollectionCheckpoint,
  InferCollectionInsertModel,
  InferCollectionPrimaryFieldType,
  InferCollectionSelectModel,
  InferCollectionUpdateModel,
  TCollectionRuntime,
  TCollectionRuntimeRecord,
} from "../../src";
import type {
  Checkpoint,
  Collections,
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
    expectTypeOf<Todos["get"]>().returns.resolves.toEqualTypeOf<TodoSelect>();
    expectTypeOf<Todos["getMany"]>().returns.resolves.toEqualTypeOf<TodoSelect[]>();
  });
});
