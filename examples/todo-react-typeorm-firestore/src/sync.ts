import { createLocalStorageCheckpointStorage } from "@ez-kits/sync-client-core";
import { createSyncClientReact } from "@ez-kits/sync-client-react";
import { defineTypeormCollection } from "@ez-kits/sync-client-typeorm-adapter";
import { createTypeOrmSqliteDBAdapter } from "@ez-kits/sync-client-typeorm-adapter/sqlite";
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
import { dbStorage } from "./db/index.ts";
import { Todo } from "./db/schema.ts";
import { firestore, isFirebaseConfigured } from "./firebase.ts";

export interface TodoCheckpoint {
  updatedAt: Timestamp;
  id: string;
}

const todosCollection = defineTypeormCollection<"todos", typeof Todo, "id", TodoCheckpoint>({
  name: "todos",
  entity: Todo,
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

export { dbStorage };

/**
 * TypeORM over the shared sql.js storage: the adapter creates the data source, whose
 * statements run on the leader's database from every tab, and its own outbox tables. The
 * storage leader's tab is the only one that syncs with Firestore.
 */
const dbAdapter = createTypeOrmSqliteDBAdapter({ dbStorage, collections: [todosCollection] });

export const { syncClient, SyncClientProvider, useSyncClient, useLiveQuery } =
  createSyncClientReact({
    collections: [todosCollection],
    dbAdapter,
    checkpointStorage: createLocalStorageCheckpointStorage<string, TodoCheckpoint>({
      key: "ez-sync-todo-typeorm-checkpoint",
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
    /**
     * Firestore refused a write on its own (security rules, validation). It stays in the
     * outbox and is retried, so log it and keep it. A write that can never succeed (rules
     * or data that will not change) would be dropped with `rejection.discard()`, then the
     * local row reverted, e.g. by reading the document back with `getDoc` and writing it
     * locally, or left for the user to fix and save again.
     */
    onPushRejected: (rejection) => {
      console.warn(
        "Firestore rejected a todo write; it stays queued:",
        rejection.event,
        rejection.error,
      );
    },
  });

/*
 * This example does not use Firebase Auth. With rules that require a signed-in user, writes
 * made while signed out are refused and parked; push them as soon as the user signs in:
 *
 *   import { getAuth, onAuthStateChanged } from "firebase/auth";
 *
 *   onAuthStateChanged(getAuth(), (user) => {
 *     if (user) syncClient.retryRejectedPushes();
 *   });
 */
