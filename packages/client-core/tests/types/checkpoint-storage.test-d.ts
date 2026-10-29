import { expectTypeOf, test } from "vite-plus/test";
import {
  createDBCheckpointStorage,
  createSyncClient,
  isTransactionalCheckpointStorage,
  type ICheckpointStorage,
  type ILocalChangeStore,
  type InferCheckpointFromStorage,
  type SkippedRemoteEvent,
  type SyncClient,
  type TransactionalCheckpointStorage,
} from "../../src";
import { checkpointStorage, collections, db, store, type Checkpoint } from "./fixtures";

const dbCheckpoints = createDBCheckpointStorage<"todos" | "users", Checkpoint>({
  localChangeStore: db.localChangeStore,
  serializer: (checkpoint) => JSON.stringify(checkpoint),
  deserializer: (value) => JSON.parse(value) as Checkpoint,
});

test("the DB checkpoint storage is a checkpoint storage that joins transactions", () => {
  expectTypeOf(dbCheckpoints).toEqualTypeOf<
    TransactionalCheckpointStorage<"todos" | "users", Checkpoint>
  >();
  expectTypeOf(dbCheckpoints).toExtend<ICheckpointStorage<"todos" | "users", Checkpoint>>();
  expectTypeOf<InferCheckpointFromStorage<typeof dbCheckpoints>>().toEqualTypeOf<Checkpoint>();
  expectTypeOf(dbCheckpoints.getCheckpoint("todos", {})).resolves.toEqualTypeOf<
    Checkpoint | undefined
  >();
  expectTypeOf(dbCheckpoints.localChangeStore).toEqualTypeOf<ILocalChangeStore>();
  // @ts-expect-error checkpoints only accept known collection names
  void dbCheckpoints.saveCheckpoint("projects", { cursor: "c" });

  const client = createSyncClient({ collections, dbAdapter: db, checkpointStorage: dbCheckpoints });
  expectTypeOf(client).toExtend<SyncClient<any, any, Checkpoint>>();
  if (isTransactionalCheckpointStorage(checkpointStorage)) {
    expectTypeOf(checkpointStorage).toExtend<TransactionalCheckpointStorage<any, Checkpoint>>();
  }
});

test("the local-change store keeps serialized checkpoints and skipped remote events", () => {
  expectTypeOf(store.getCheckpoint("todos")).resolves.toEqualTypeOf<string | undefined>();
  expectTypeOf<ILocalChangeStore["saveCheckpoint"]>()
    .parameter(1)
    .toEqualTypeOf<string | undefined>();
  expectTypeOf(
    store.getSkippedRemoteEvents({ collection: "todos", recordId: "1" }),
  ).resolves.toEqualTypeOf<SkippedRemoteEvent[]>();
  expectTypeOf<SkippedRemoteEvent>().toEqualTypeOf<{
    collection: string;
    recordId: string;
    event: unknown;
  }>();
  expectTypeOf<ILocalChangeStore<{ kind: "tx" }>["upsertSkippedRemoteEvent"]>()
    .parameter(1)
    .toEqualTypeOf<{ kind: "tx" } | undefined>();
});
