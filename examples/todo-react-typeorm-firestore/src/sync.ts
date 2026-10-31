import { createScopedSyncClientReact } from "@ez-kits/sync-client-react";
import { defineTypeOrmCollection } from "@ez-kits/sync-client-typeorm-adapter";
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
import { createTodoDBStorage } from "./db/index.ts";
import { Todo } from "./db/schema.ts";
import { firestore, isFirebaseConfigured } from "./firebase.ts";

export interface TodoCheckpoint {
  updatedAt: Timestamp;
  id: string;
}

const todosCollection = defineTypeOrmCollection({
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

/** Each account syncs only its own subtree: `users/{account}/todos`. */
function createTodoFirestoreSyncAdapter(account: string) {
  if (!firestore || !isFirebaseConfigured()) return undefined;

  return createFirestoreSyncAdapter({
    db: firestore,
    collections: [
      defineFirestoreCollectionSyncAdapterConfig({
        collectionConfig: todosCollection,
        collectionPath: `users/${account}/todos`,
        buildPullQueryConstraints: ({ checkpoint }) => [
          orderBy("updatedAt", "asc"),
          orderBy(documentId(), "asc"),
          ...(checkpoint ? [startAfter(checkpoint.updatedAt, checkpoint.id)] : []),
        ],
        createCheckpoint: () => ({ updatedAt: Timestamp.fromMillis(0), id: "" }),
        createPullCheckpoint: ({ snapshot, previousCheckpoint }) =>
          checkpointFromSnapshot(snapshot, previousCheckpoint),
        resolveRemoteId: (event) => {
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

/**
 * One sync client per account. `<SyncClientProvider scope={account}>` opens the account's
 * client and closes the previous one; writes not yet pushed stay in that account's database
 * and are pushed when it is opened again.
 */
export const { SyncClientProvider, useSyncClient, useLiveQuery } = createScopedSyncClientReact({
  /**
   * Everything that belongs to one account: its local database, TypeORM over it, and its
   * Firestore path. The collection, the Firestore handlers and the conflict rule are the
   * same for every account.
   */
  createConfig: (account: string) => {
    const dbStorage = createTodoDBStorage(account);
    return {
      collections: [todosCollection],
      // The adapter creates the data source, whose statements run on the leader's database
      // from every tab of the account. The storage leader's tab is the only one that syncs.
      dbAdapter: createTypeOrmSqliteDBAdapter({ dbStorage, collections: [todosCollection] }),
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
      syncAdapter: createTodoFirestoreSyncAdapter(account),
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
    };
  },
});

export type TodoSyncClient = ReturnType<typeof useSyncClient>;

/*
 * This example does not use Firebase Auth: the account switcher stands in for it. With Auth,
 * use the signed-in user's id as the scope, and switch only once Auth has signed that user
 * in, so the account's first pushes are not refused by rules like
 * `match /users/{userId}/{document=**} { allow read, write: if request.auth.uid == userId; }`:
 *
 *   const [uid, setUid] = useState<string>();
 *   useEffect(() => onAuthStateChanged(getAuth(), (user) => setUid(user?.uid)), []);
 *   return uid ? <SyncClientProvider scope={uid}>…</SyncClientProvider> : <SignIn />;
 */
