import { expectTypeOf, test } from "vite-plus/test";
import type {
  ChangeBusEvent,
  ChangeBusEventDataMapFromCollectionConfigMap,
  ChangeBusSubscribeStream,
} from "../../src";
import type { Collections, TodoInsert, TodoSelect, TodoUpdate, UserInsert } from "./fixtures";

type DataMap = ChangeBusEventDataMapFromCollectionConfigMap<Collections>;

test("data map is derived from collection configs", () => {
  expectTypeOf<keyof DataMap>().toEqualTypeOf<"todos" | "users">();
  expectTypeOf<DataMap["todos"]>().toEqualTypeOf<{
    create: TodoInsert;
    update: TodoUpdate;
    delete: number;
    record: TodoSelect;
  }>();
});

test("events narrow by collection and type", () => {
  type TodoEvent = ChangeBusEvent<DataMap, "todos">;
  expectTypeOf<TodoEvent["collection"]>().toEqualTypeOf<"todos">();
  expectTypeOf<Extract<TodoEvent, { type: "create" }>["data"]>().toEqualTypeOf<TodoInsert>();
  expectTypeOf<Extract<TodoEvent, { type: "update" }>["data"]>().toEqualTypeOf<TodoUpdate>();
  expectTypeOf<Extract<TodoEvent, { type: "delete" }>["id"]>().toEqualTypeOf<number>();

  type AnyEvent = ChangeBusEvent<DataMap>;
  expectTypeOf<AnyEvent["collection"]>().toEqualTypeOf<"todos" | "users">();
  expectTypeOf<
    Extract<AnyEvent, { collection: "users"; type: "create" }>["data"]
  >().toEqualTypeOf<UserInsert>();
});

test("subscribe streams are a closed union", () => {
  expectTypeOf<ChangeBusSubscribeStream>().toEqualTypeOf<"local" | "remote" | "both">();
});
