import { expectTypeOf, test } from "vite-plus/test";
import {
  APPLIED_EVENT_RETENTION_MS,
  isLocalMutationCommitted,
  type DirtyRecord,
  type DirtyRecordKey,
  type ILocalChangeStore,
  type LocalChangeScope,
  type LocalMutation,
  type StoredChangeBusEvent,
} from "../../src";
import { store } from "./fixtures";

test("reads take a collection or one record, and a transaction context", () => {
  expectTypeOf<LocalChangeScope>().toEqualTypeOf<string | DirtyRecordKey>();
  expectTypeOf(store.getPendingEvents()).resolves.toEqualTypeOf<StoredChangeBusEvent[]>();
  expectTypeOf(store.getPendingEvents("todos")).resolves.toEqualTypeOf<StoredChangeBusEvent[]>();
  expectTypeOf(
    store.getDirtyRecords({ collection: "todos", recordId: "1" }, {}),
  ).resolves.toEqualTypeOf<DirtyRecord[]>();
  // @ts-expect-error a record scope names its collection
  void store.getPendingEvents({ recordId: "1" });

  type Typed = ILocalChangeStore<{ kind: "tx" }>;
  expectTypeOf<Typed["getPendingEvents"]>()
    .parameter(1)
    .toEqualTypeOf<{ kind: "tx" } | undefined>();
  expectTypeOf<Typed["getDirtyRecords"]>().parameter(1).toEqualTypeOf<{ kind: "tx" } | undefined>();
});

test("stores answer whether an event was applied, and retries ask them", () => {
  expectTypeOf(store.hasAppliedEvent("e1")).resolves.toEqualTypeOf<boolean>();
  expectTypeOf<ILocalChangeStore<{ kind: "tx" }>["hasAppliedEvent"]>()
    .parameter(1)
    .toEqualTypeOf<{ kind: "tx" } | undefined>();
  expectTypeOf(APPLIED_EVENT_RETENTION_MS).toEqualTypeOf<number>();
  expectTypeOf(isLocalMutationCommitted).parameters.toEqualTypeOf<
    [ILocalChangeStore, LocalMutation]
  >();
  expectTypeOf(isLocalMutationCommitted).returns.resolves.toEqualTypeOf<boolean>();
});

test("the database assigns event order: stored events carry no sequence", () => {
  expectTypeOf<StoredChangeBusEvent>().not.toHaveProperty("seq");
});
