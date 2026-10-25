import { createLocalStorageCheckpointStorage } from "@ez-kits/sync-client-core";
import {
  createDrizzleStorage,
  defineDrizzleCollection,
} from "@ez-kits/sync-client-drizzle-adapter";
import { createSyncClientReact } from "@ez-kits/sync-client-react";
import { lastWriteWins } from "@ez-kits/sync-conflict-resolution";
import {
  createFirestoreSyncAdapter,
  defineFirestoreCollectionSyncAdapterConfig,
} from "@ez-kits/sync-firebase/sync-firestore";
import {
  documentId,
  orderBy,
  serverTimestamp,
  startAfter,
  Timestamp,
  type QuerySnapshot,
} from "firebase/firestore";
import { db } from "./db/index.ts";
import { dirtyRecords, schema, syncEvents, todos, type Todo } from "./db/schema.ts";
import { firestore, isFirebaseConfigured } from "./firebase.ts";

export interface TodoCheckpoint {
  updatedAt: Timestamp;
  id: string;
}

const todosCollection = defineDrizzleCollection<"todos", typeof todos, "id", Todo, TodoCheckpoint>({
  name: "todos",
  table: todos,
  primaryField: "id",
});

function checkpointFromSnapshot(
  snapshot: QuerySnapshot,
  previousCheckpoint?: TodoCheckpoint,
): TodoCheckpoint {
  let next = previousCheckpoint;
  for (const change of snapshot.docChanges()) {
    const updatedAt = change.doc.data().updatedAt;
    if (!(updatedAt instanceof Timestamp)) continue;
    const id = change.doc.id;
    if (
      !next ||
      updatedAt.toMillis() > next.updatedAt.toMillis() ||
      (updatedAt.toMillis() === next.updatedAt.toMillis() && id > next.id)
    ) {
      next = { updatedAt, id };
    }
  }
  return next ?? { updatedAt: Timestamp.fromMillis(0), id: "" };
}

function timestampToMillis(value: unknown): number | undefined {
  if (value instanceof Timestamp) return value.toMillis();
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
          orderBy(documentId(), "asc"),
          ...(checkpoint ? [startAfter(checkpoint.updatedAt, checkpoint.id)] : []),
        ],
        createCheckpoint: () => ({ updatedAt: Timestamp.fromMillis(0), id: "" }),
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
        serializeDelete: (_id, { deletedAt }) => ({
          deleted: true,
          deletedAt: Timestamp.fromMillis(deletedAt),
          updatedAt: Timestamp.fromMillis(deletedAt),
        }),
        resolveDeletedAt: (data) => timestampToMillis(data.deletedAt),
        deserializeCreate: (data) => ({
          id: String(data.id),
          title: String(data.title ?? ""),
          completed: Boolean(data.completed),
          updatedAt: timestampToMillis(data.updatedAt) ?? 0,
        }),
        deserializeUpdate: (data) => ({
          id: String(data.id),
          title: String(data.title ?? ""),
          completed: Boolean(data.completed),
          updatedAt: timestampToMillis(data.updatedAt) ?? 0,
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
          updatedAt: {
            seconds: checkpoint.updatedAt.seconds,
            nanoseconds: checkpoint.updatedAt.nanoseconds,
          },
          id: checkpoint.id,
        }),
      deserializer: (value) => {
        const parsed = JSON.parse(value) as {
          updatedAt: { seconds: number; nanoseconds: number };
          id: string;
        };
        return {
          updatedAt: new Timestamp(parsed.updatedAt.seconds, parsed.updatedAt.nanoseconds),
          id: parsed.id,
        };
      },
    }),
    resolveConflict: lastWriteWins({
      getLocalVersion(local) {
        if (!local) return undefined;
        return local.updatedAt;
      },
      getRemoteVersion(remote) {
        if (remote.type === "delete") return remote.deletedAt;
        return remote.data.updatedAt;
      },
      onMissingVersion: "local",
      onTie: "local",
    }),
    syncAdapter: createTodoFirestoreSyncAdapter(),
  });
