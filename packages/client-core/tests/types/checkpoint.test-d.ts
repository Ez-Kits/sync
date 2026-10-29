import { expectTypeOf, test } from "vite-plus/test";
import {
  createSyncClient,
  type ILocalChangeStore,
  type SkippedRemoteEvent,
  type SyncClient,
  type SyncClientConfig,
} from "../../src";
import type * as PublicAPI from "../../src";
import { collections, db, store, type Checkpoint, type Collections, type DB } from "./fixtures";

test("checkpoints are serialized with a typed `checkpoint` option, JSON by default", () => {
  const client = createSyncClient({
    collections,
    dbAdapter: db,
    checkpoint: {
      serialize: (checkpoint) => {
        expectTypeOf(checkpoint).toEqualTypeOf<Checkpoint>();
        return checkpoint.cursor;
      },
      deserialize: (value) => ({ cursor: value }),
    },
  });
  expectTypeOf(client).toEqualTypeOf<SyncClient<Collections, DB, Checkpoint>>();
  expectTypeOf(createSyncClient({ collections, dbAdapter: db })).toEqualTypeOf<
    SyncClient<Collections, DB, Checkpoint>
  >();
  expectTypeOf<SyncClientConfig<Collections, DB, Checkpoint>["checkpoint"]>().toEqualTypeOf<
    | { serialize: (checkpoint: Checkpoint) => string; deserialize: (value: string) => Checkpoint }
    | undefined
  >();

  createSyncClient({
    collections,
    dbAdapter: db,
    checkpoint: {
      // @ts-expect-error a serializer returns the string stored in the database
      serialize: (checkpoint: Checkpoint) => checkpoint,
      deserialize: (value: string) => ({ cursor: value }),
    },
  });
  createSyncClient({
    collections,
    dbAdapter: db,
    // @ts-expect-error a serializer needs its deserializer
    checkpoint: { serialize: (checkpoint: Checkpoint) => checkpoint.cursor },
  });
});

test("checkpoint storage is not configurable", () => {
  createSyncClient({
    collections,
    dbAdapter: db,
    // @ts-expect-error checkpoints always live in the adapter's local-change store
    checkpointStorage: { getCheckpoint: async () => undefined, saveCheckpoint: async () => {} },
  });
  expectTypeOf<SyncClientConfig<Collections, DB, Checkpoint>>().not.toHaveProperty(
    "checkpointStorage",
  );
});

test("the checkpoint storage helpers are not exported", () => {
  expectTypeOf<typeof PublicAPI>().not.toHaveProperty("createLocalStorageCheckpointStorage");
  expectTypeOf<typeof PublicAPI>().not.toHaveProperty("createDBCheckpointStorage");
  expectTypeOf<typeof PublicAPI>().not.toHaveProperty("isTransactionalCheckpointStorage");
  // @ts-expect-error not exported
  type _Storage = PublicAPI.ICheckpointStorage<"todos", Checkpoint>;
  // @ts-expect-error not exported
  type _Transactional = PublicAPI.TransactionalCheckpointStorage<"todos", Checkpoint>;
  // @ts-expect-error not exported
  type _Serialization = PublicAPI.CheckpointSerialization<Checkpoint>;
  // @ts-expect-error not exported
  type _Infer = PublicAPI.InferCheckpointFromStorage<unknown>;
});

test("the client reads and resets checkpoints with the configured type", () => {
  const client = createSyncClient({ collections, dbAdapter: db });
  expectTypeOf(client.getCheckpoint("todos")).resolves.toEqualTypeOf<Checkpoint | undefined>();
  expectTypeOf(client.saveCheckpoint).parameter(1).toEqualTypeOf<Checkpoint | undefined>();
  // @ts-expect-error checkpoints only accept known collection names
  void client.saveCheckpoint("projects", { cursor: "c" });
  // @ts-expect-error checkpoints are typed
  void client.saveCheckpoint("todos", { cursor: 1 });
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
