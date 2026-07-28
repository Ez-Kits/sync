import { createLocalStorageCheckpointStorage } from "@ez-kits/sync-client-core";
import {
  createDrizzleDBAdapter,
  defineDrizzleCollection,
} from "@ez-kits/sync-client-drizzle-adapter";
import { createSyncClientReact } from "@ez-kits/sync-client-react";
import {
  createFirestoreSyncOptions,
  defineFirestoreCollectionSyncConfig,
} from "@ez-kits/sync-firebase/sync-firestore";
import { orderBy, startAfter } from "firebase/firestore";
import { db } from "./db/index.ts";
import { schema, todos } from "./db/schema.ts";
import { firestore, isFirebaseConfigured } from "./firebase.ts";

export type TodoCheckpoint = number;

const todosCollection = defineDrizzleCollection({
  name: "todos",
  table: todos,
  primaryField: "id",
});

function createTodoFirestoreSync() {
  if (!firestore || !isFirebaseConfigured()) return undefined;

  return createFirestoreSyncOptions({
    db: firestore,
    collections: [
      defineFirestoreCollectionSyncConfig({
        collectionConfig: todosCollection,
        collectionPath: "todos",
        buildPullQueryConstraints: ({ checkpoint }) => [
          orderBy("updatedAt", "desc"),
          ...(checkpoint ? [startAfter(checkpoint)] : []),
        ],
        createCheckpoint: () => Date.now(),
        createPullCheckpoint: () => Date.now(),
        resolveDocumentId: (event) => {
          if (event.type === "delete") return String(event.id);
          return String(event.data.id);
        },
        serializeCreate: (data) => ({
          id: data.id,
          title: data.title,
          completed: data.completed ?? false,
          updatedAt: data.updatedAt,
          deleted: false,
        }),
        serializeUpdate: (data) => ({
          ...data,
          deleted: false,
        }),
        deserializeCreate: (data) => ({
          id: String(data.id),
          title: String(data.title ?? ""),
          completed: Boolean(data.completed),
          updatedAt: Number(data.updatedAt ?? Date.now()),
        }),
        deserializeUpdate: (data) => ({
          id: String(data.id),
          title: String(data.title ?? ""),
          completed: Boolean(data.completed),
          updatedAt: Number(data.updatedAt ?? Date.now()),
        }),
        deserializeDeleteId: ({ snapshot }) => snapshot.id,
      }),
    ],
  });
}

export const { syncClient, SyncClientProvider, useSyncClient, useLiveQuery } =
  createSyncClientReact({
    collections: [todosCollection],
    dbAdapter: (collections) =>
      createDrizzleDBAdapter({
        db,
        collections,
        schema,
      }),
    checkpointStorage: createLocalStorageCheckpointStorage<string, TodoCheckpoint>({
      key: "ez-sync-todo-checkpoint",
      serializer: (checkpoint) => JSON.stringify(checkpoint),
      deserializer: (value) => JSON.parse(value) as TodoCheckpoint,
    }),
    sync: createTodoFirestoreSync(),
  });
