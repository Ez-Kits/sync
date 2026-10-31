import type {
  ChangeBusEvent,
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
// The collection says nothing about checkpoints: the adapter config infers them.
type TodoConfig = CollectionConfig<"todos", unknown, Partial<Todo>, Omit<Todo, "id">, Todo, "id">;
type DataMap = ChangeBusEventDataMapFromCollectionConfigMap<[TodoConfig]>;
type ClientSyncAdapter = NonNullable<
  SyncClientConfig<[TodoConfig], any, Checkpoint>["syncAdapter"]
>;

declare const todoConfig: TodoConfig;
declare const firestore: Firestore;
declare const database: Database;
/** Remote ids are derived from the local event: the record id, or the deleted id. */
const eventId = (event: ChangeBusEvent<DataMap, "todos">) =>
  event.type === "delete" ? event.id : "generated";

describe("firestore", () => {
  const config = defineFirestoreCollectionSyncAdapterConfig({
    collectionConfig: todoConfig,
    collectionPath: "todos",
    createCheckpoint: () => ({ updatedAt: 0 }),
    resolveRemoteId: (event) => {
      expectTypeOf(event).toEqualTypeOf<ChangeBusEvent<DataMap, "todos">>();
      return eventId(event);
    },
    serializeCreate: (data) => {
      expectTypeOf(data).toEqualTypeOf<Omit<Todo, "id">>();
      return data as DocumentData;
    },
    serializeDelete: (id) => {
      expectTypeOf(id).toEqualTypeOf<string>();
      return {};
    },
  });

  test("collection config is derived from the core collection, its checkpoint from the handlers", () => {
    expectTypeOf(config).toEqualTypeOf<
      FirestoreSyncAdapterCollectionConfig<DataMap, "todos", Checkpoint>
    >();
    expectTypeOf(config.collectionName).toEqualTypeOf<"todos">();

    const cursor = defineFirestoreCollectionSyncAdapterConfig({
      collectionConfig: todoConfig,
      collectionPath: "todos",
      resolveRemoteId: eventId,
      createCheckpoint: () => ({ cursor: "x" }),
      buildPullQueryConstraints: ({ checkpoint }) => {
        expectTypeOf(checkpoint).toEqualTypeOf<{ cursor: string } | undefined>();
        return [];
      },
      createPullCheckpoint: ({ previousCheckpoint }) => {
        expectTypeOf(previousCheckpoint).toEqualTypeOf<{ cursor: string } | undefined>();
        return { cursor: "y" };
      },
    });
    expectTypeOf(cursor).toEqualTypeOf<
      FirestoreSyncAdapterCollectionConfig<DataMap, "todos", { cursor: string }>
    >();
    // @ts-expect-error every collection must say how local events map to document ids
    defineFirestoreCollectionSyncAdapterConfig({
      collectionConfig: todoConfig,
      collectionPath: "todos",
      createCheckpoint: () => ({ updatedAt: 0 }),
    });
  });

  test("adapters are typed sync adapters accepted by the client", () => {
    const adapter = createFirestoreSyncAdapter({ db: firestore, collections: [config] });
    expectTypeOf(adapter).toEqualTypeOf<SyncAdapter<DataMap, "todos", Checkpoint>>();
    expectTypeOf(adapter).toExtend<ClientSyncAdapter>();
    createFirestoreSyncAdapter({
      db: firestore,
      collections: [config],
      checkpointSerializer: {
        serialize: (checkpoint) => {
          expectTypeOf(checkpoint).toEqualTypeOf<Checkpoint>();
          return String(checkpoint.updatedAt);
        },
        deserialize: (value) => ({ updatedAt: Number(value) }),
      },
    });

    const single = createFirestoreCollectionSyncAdapter<DataMap, "todos", Checkpoint>({
      db: firestore,
      collectionPath: "todos",
      createCheckpoint: () => ({ updatedAt: 0 }),
      resolveRemoteId: eventId,
    });
    expectTypeOf(single).toEqualTypeOf<SyncAdapter<DataMap, "todos", Checkpoint>>();
  });
});

describe("realtime database", () => {
  const config = defineRealtimeDBCollectionSyncAdapterConfig({
    collectionConfig: todoConfig,
    collectionPath: "todos",
    createCheckpoint: () => ({ updatedAt: 0 }),
    resolveRemoteId: (event) => {
      expectTypeOf(event).toEqualTypeOf<ChangeBusEvent<DataMap, "todos">>();
      return eventId(event);
    },
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
    createRealtimeDBSyncAdapter({
      db: database,
      collections: [config],
      checkpointSerializer: {
        serialize: (checkpoint) => {
          expectTypeOf(checkpoint).toEqualTypeOf<Checkpoint>();
          return String(checkpoint.updatedAt);
        },
        deserialize: (value) => ({ updatedAt: Number(value) }),
      },
    });

    const single = createRealtimeDBCollectionSyncAdapter<DataMap, "todos", Checkpoint>({
      db: database,
      collectionPath: "todos",
      createCheckpoint: () => ({ updatedAt: 0 }),
      resolveRemoteId: eventId,
    });
    expectTypeOf(single).toEqualTypeOf<SyncAdapter<DataMap, "todos", Checkpoint>>();
    // @ts-expect-error a realtime database adapter requires a Database, not a Firestore
    createRealtimeDBSyncAdapter({ db: firestore, collections: [config] });
  });
});
