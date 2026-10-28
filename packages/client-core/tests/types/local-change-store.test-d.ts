import { expectTypeOf, test } from "vite-plus/test";
import type {
  DirtyRecord,
  DirtyRecordKey,
  ILocalChangeStore,
  LocalChangeScope,
  StoredChangeBusEvent,
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

test("the database assigns event order: stored events carry no sequence", () => {
  expectTypeOf<StoredChangeBusEvent>().not.toHaveProperty("seq");
});
