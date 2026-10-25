import type {
  ChangeBusEventDataMapFromCollectionConfigMap,
  CollectionConfig,
  SyncAdapter,
  SyncClientConfig,
} from "@ez-kits/sync-client-core";
import type { Database } from "firebase/database";
import type { DocumentData, Firestore } from "firebase/firestore";
import { describe, expectTypeOf, test } from "vite-plus/test";
import {
  createFirestoreCollectionSyncAdapter,
  createFirestoreSyncAdapter,
  defineFirestoreCollectionSyncAdapterConfig,
  type FirestoreSyncAdapterCollectionConfig,
} from "../../src/sync-firestore.ts";
import {
  createRealtimeDBCollectionSyncAdapter,
  createRealtimeDBSyncAdapter,
  defineRealtimeDBCollectionSyncAdapterConfig,
  type RealtimeDBSyncAdapterCollectionConfig,
} from "../../src/sync-realtime-db.ts";

interface Todo {
  id: string;
  title: string;
}
interface Checkpoint {
  updatedAt: number;
}
type TodoConfig = CollectionConfig<
  "todos",
  unknown,
  Partial<Todo>,
  Omit<Todo, "id">,
  Todo,
  "id",
  Checkpoint
>;
type DataMap = ChangeBusEventDataMapFromCollectionConfigMap<[TodoConfig]>;
type ClientSyncAdapter = NonNullable<
  SyncClientConfig<[TodoConfig], any, Checkpoint, any>["syncAdapter"]
>;

declare const todoConfig: TodoConfig;
declare const firestore: Firestore;
declare const database: Database;

describe("firestore", () => {
  const config = defineFirestoreCollectionSyncAdapterConfig({
    collectionConfig: todoConfig,
    collectionPath: "todos",
    createCheckpoint: () => ({ updatedAt: 0 }),
    serializeCreate: (data) => {
      expectTypeOf(data).toEqualTypeOf<Omit<Todo, "id">>();
      return data as DocumentData;
    },
    serializeDelete: (id) => {
      expectTypeOf(id).toEqualTypeOf<string>();
      return {};
    },
  });

  test("collection config is derived from the core collection", () => {
    expectTypeOf(config).toEqualTypeOf<
      FirestoreSyncAdapterCollectionConfig<DataMap, "todos", Checkpoint>
    >();
    expectTypeOf(config.collectionName).toEqualTypeOf<"todos">();

    defineFirestoreCollectionSyncAdapterConfig({
      collectionConfig: todoConfig,
      collectionPath: "todos",
      // @ts-expect-error checkpoints must match the collection checkpoint type
      createCheckpoint: () => ({ cursor: "x" }),
    });
  });

  test("adapters are typed sync adapters accepted by the client", () => {
    const adapter = createFirestoreSyncAdapter({ db: firestore, collections: [config] });
    expectTypeOf(adapter).toEqualTypeOf<SyncAdapter<DataMap, "todos", Checkpoint>>();
    expectTypeOf(adapter).toExtend<ClientSyncAdapter>();

    const single = createFirestoreCollectionSyncAdapter<DataMap, "todos", Checkpoint>({
      db: firestore,
      collectionPath: "todos",
      createCheckpoint: () => ({ updatedAt: 0 }),
    });
    expectTypeOf(single).toEqualTypeOf<SyncAdapter<DataMap, "todos", Checkpoint>>();
  });
});

describe("realtime database", () => {
  const config = defineRealtimeDBCollectionSyncAdapterConfig({
    collectionConfig: todoConfig,
    collectionPath: "todos",
    createCheckpoint: () => ({ updatedAt: 0 }),
    serializeUpdate: (data) => {
      expectTypeOf(data).toEqualTypeOf<Partial<Todo>>();
      return data;
    },
  });

  test("collection config is derived from the core collection", () => {
    expectTypeOf(config).toEqualTypeOf<
      RealtimeDBSyncAdapterCollectionConfig<DataMap, "todos", Checkpoint>
    >();
  });

  test("adapters are typed sync adapters accepted by the client", () => {
    const adapter = createRealtimeDBSyncAdapter({ db: database, collections: [config] });
    expectTypeOf(adapter).toEqualTypeOf<SyncAdapter<DataMap, "todos", Checkpoint>>();
    expectTypeOf(adapter).toExtend<ClientSyncAdapter>();

    const single = createRealtimeDBCollectionSyncAdapter<DataMap, "todos", Checkpoint>({
      db: database,
      collectionPath: "todos",
      createCheckpoint: () => ({ updatedAt: 0 }),
    });
    expectTypeOf(single).toEqualTypeOf<SyncAdapter<DataMap, "todos", Checkpoint>>();
    // @ts-expect-error a realtime database adapter requires a Database, not a Firestore
    createRealtimeDBSyncAdapter({ db: firestore, collections: [config] });
  });
});
