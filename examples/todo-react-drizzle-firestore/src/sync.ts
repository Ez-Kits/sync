import { createLocalStorageCheckpointStorage } from "@ez-kits/sync-client-core";
import {
  createDrizzleStorage,
  defineDrizzleCollection,
} from "@ez-kits/sync-client-drizzle-adapter";
import { createSyncClientReact } from "@ez-kits/sync-client-react";
import {
  createFirestoreSyncAdapter,
  defineFirestoreCollectionSyncAdapterConfig,
} from "@ez-kits/sync-firebase/sync-firestore";
import {
  orderBy,
  serverTimestamp,
  startAfter,
  Timestamp,
  type QuerySnapshot,
} from "firebase/firestore";
import { db } from "./db/index.ts";
import { dirtyRecords, schema, syncEvents, todos } from "./db/schema.ts";
import { firestore, isFirebaseConfigured } from "./firebase.ts";

export type TodoCheckpoint = Timestamp;

const todosCollection = defineDrizzleCollection({
  name: "todos",
  table: todos,
  primaryField: "id",
});

function checkpointFromSnapshot(snapshot: QuerySnapshot, previousCheckpoint?: unknown): Timestamp {
  let next = previousCheckpoint instanceof Timestamp ? previousCheckpoint : undefined;
  for (const change of snapshot.docChanges()) {
    const updatedAt = change.doc.data().updatedAt;
    if (!(updatedAt instanceof Timestamp)) continue;
    if (!next || updatedAt.toMillis() > next.toMillis()) {
      next = updatedAt;
    }
  }
  return next ?? Timestamp.now();
}

function createTodoFirestoreSyncAdapter() {
  if (!firestore || !isFirebaseConfigured()) return undefined;

  return createFirestoreSyncAdapter({
    db: firestore,
    collections: [
      defineFirestoreCollectionSyncAdapterConfig({
        collectionConfig: todosCollection,
        collectionPath: "todos",
        buildPullQueryConstraints: ({ checkpoint }) => [
          orderBy("updatedAt", "asc"),
          ...(checkpoint ? [startAfter(checkpoint)] : []),
        ],
        createCheckpoint: () => Timestamp.now(),
        createPullCheckpoint: ({ snapshot, previousCheckpoint }) =>
          checkpointFromSnapshot(snapshot, previousCheckpoint),
        resolveDocumentId: (event) => {
          if (event.type === "delete") return String(event.id);
          return String(event.data.id);
        },
        serializeCreate: (data) => ({
          id: data.id,
          title: data.title,
          completed: data.completed ?? false,
          updatedAt: serverTimestamp(),
          deleted: false,
        }),
        serializeUpdate: (data) => ({
          ...data,
          updatedAt: serverTimestamp(),
          deleted: false,
        }),
        deserializeCreate: (data) => ({
          id: String(data.id),
          title: String(data.title ?? ""),
          completed: Boolean(data.completed),
        }),
        deserializeUpdate: (data) => ({
          id: String(data.id),
          title: String(data.title ?? ""),
          completed: Boolean(data.completed),
        }),
        deserializeDeleteId: ({ snapshot }) => snapshot.id,
      }),
    ],
  });
}

export const { syncClient, SyncClientProvider, useSyncClient, useLiveQuery } =
  createSyncClientReact({
    collections: [todosCollection],
    storage: createDrizzleStorage({
      db,
      collections: [todosCollection],
      schema,
      localChangeTables: { events: syncEvents, dirtyRecords },
    }),
    checkpointStorage: createLocalStorageCheckpointStorage<string, TodoCheckpoint>({
      key: "ez-sync-todo-checkpoint",
      serializer: (checkpoint) =>
        JSON.stringify({
          seconds: checkpoint.seconds,
          nanoseconds: checkpoint.nanoseconds,
        }),
      deserializer: (value) => {
        const parsed = JSON.parse(value) as { seconds: number; nanoseconds: number };
        return new Timestamp(parsed.seconds, parsed.nanoseconds);
      },
    }),
    syncAdapter: createTodoFirestoreSyncAdapter(),
  });
