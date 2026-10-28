import { expectTypeOf, test } from "vite-plus/test";
import type {
  DBAdapterOperations,
  DBAdapterTransactionContext,
  LocalMutationTransactionContext,
} from "../../src";
import { db, type Collections, type DB, type TodoSelect, type UserSelect } from "./fixtures";

test("adapter reads return the collection select model", () => {
  expectTypeOf(db.get("todos", 1)).resolves.toEqualTypeOf<TodoSelect>();
  expectTypeOf(db.get("users", "u1")).resolves.toEqualTypeOf<UserSelect>();
  expectTypeOf(db.getMany("todos")).resolves.toEqualTypeOf<TodoSelect[]>();
  expectTypeOf(db.getOptional!("todos", 1)).resolves.toEqualTypeOf<TodoSelect | undefined>();
});

test("adapter writes are checked against the collection models", async () => {
  await db.insert("todos", { title: "write type tests" });
  await db.update("users", { uid: "u1", email: "a@b.c" });
  await db.delete("todos", 1);

  // @ts-expect-error unknown collection names are rejected
  await db.insert("projects", { title: "x" });
  // @ts-expect-error insert payload must match the todos insert model
  await db.insert("todos", { done: true });
  // @ts-expect-error todos are keyed by a numeric id
  await db.delete("todos", "1");
  // @ts-expect-error users are keyed by a string uid
  await db.get("users", 1);
});

test("transactions keep typed operations and results", () => {
  expectTypeOf(db.transaction(async () => 42)).resolves.toEqualTypeOf<number>();
  expectTypeOf<DB["transaction"]>()
    .parameter(0)
    .parameter(0)
    .toEqualTypeOf<DBAdapterOperations<Collections>>();
  expectTypeOf<LocalMutationTransactionContext<Collections>["operations"]>().toEqualTypeOf<
    DBAdapterOperations<Collections>
  >();
});

test("transactions hand out the same context as local mutations", () => {
  expectTypeOf<DB["transaction"]>()
    .parameter(0)
    .parameter(1)
    .toEqualTypeOf<DBAdapterTransactionContext<Collections>>();
  expectTypeOf<LocalMutationTransactionContext<Collections>>().toEqualTypeOf<
    DBAdapterTransactionContext<Collections>
  >();
  expectTypeOf<DBAdapterTransactionContext<Collections>["native"]>().toBeUnknown();
  // Callbacks that ignore the context still type-check.
  expectTypeOf(
    db.transaction(async (tx) => tx.get("todos", 1)),
  ).resolves.toEqualTypeOf<TodoSelect>();
  void db.transaction(async (_tx, { native }) => {
    await db.localChangeStore.getPendingEvents({ collection: "todos", recordId: "1" }, native);
  });
});

test("query builder and schema keep their concrete types", () => {
  expectTypeOf(db.queryBuilder).not.toBeAny();
  expectTypeOf(db.querySchema.todos).toEqualTypeOf<{ kind: "todos-table" }>();
});
