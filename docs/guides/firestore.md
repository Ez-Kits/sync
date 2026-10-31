# Sync with Cloud Firestore

`@ez-kits/sync-firebase/sync-firestore` syncs your collections with Cloud Firestore. Each local record becomes one Firestore document.

```bash
npm install @ez-kits/sync-firebase firebase
```

## The smallest setup

```ts
import {
  createFirestoreSyncAdapter,
  defineFirestoreCollectionSyncAdapterConfig,
} from "@ez-kits/sync-firebase/sync-firestore";
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firestore = getFirestore(initializeApp(firebaseConfig));

const syncAdapter = createFirestoreSyncAdapter({
  db: firestore,
  collections: [
    defineFirestoreCollectionSyncAdapterConfig({
      collectionConfig: todosCollection, // your EzSync collection
      collectionPath: "todos", // the Firestore collection
      resolveRemoteId: (event) =>
        event.type === "delete" ? String(event.id) : String(event.data.id),
      // The checkpoint type is inferred from createCheckpoint and createPullCheckpoint.
      createCheckpoint: () => null,
    }),
  ],
});

const client = createSyncClient({ collections: [todosCollection], dbAdapter, syncAdapter });
client.startSync();
```

Add one `defineFirestoreCollectionSyncAdapterConfig(...)` per collection you want to sync.

What this does:

- **Push**: each create is a `set` of the whole record; each update is a `set` with `merge: true` of the changed fields; each delete is a tombstone (see [Deletes](#deletes)). Writes are sent in batches of up to 500.
- **Pull**: listens to the whole Firestore collection with `onSnapshot` and applies every change it reports.

This is fine for small collections. Listening to the whole collection reads **every document** each time sync starts, which costs reads and time as the collection grows. The next section fixes that.

## Pull only what changed

To pull only documents changed since the last sync, give every document an `updatedAt` **server timestamp**, query by it, and remember the last one you saw in a **checkpoint**.

```ts
import {
  documentId,
  orderBy,
  serverTimestamp,
  startAfter,
  Timestamp,
  type QuerySnapshot,
} from "firebase/firestore";

// 1. What the checkpoint holds: the last document seen, in query order.
interface TodoCheckpoint {
  updatedAt: Timestamp;
  id: string;
}

const todosCollection = defineDrizzleCollection({
  name: "todos",
  table: todos,
});

// 2. Compute the next checkpoint from a snapshot.
function nextCheckpoint(snapshot: QuerySnapshot, previous?: TodoCheckpoint): TodoCheckpoint {
  let next = previous;
  for (const change of snapshot.docChanges()) {
    const updatedAt = change.doc.data().updatedAt;
    if (!(updatedAt instanceof Timestamp)) continue; // a local write not yet stamped by the server
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

const syncAdapter = createFirestoreSyncAdapter({
  db: firestore,
  collections: [
    defineFirestoreCollectionSyncAdapterConfig({
      collectionConfig: todosCollection,
      collectionPath: "todos",
      resolveRemoteId: (event) =>
        event.type === "delete" ? String(event.id) : String(event.data.id),

      // 3. Only documents after the checkpoint, in a stable order.
      buildPullQueryConstraints: ({ checkpoint }) => [
        orderBy("updatedAt", "asc"),
        orderBy(documentId(), "asc"),
        ...(checkpoint ? [startAfter(checkpoint.updatedAt, checkpoint.id)] : []),
      ],
      createCheckpoint: () => ({ updatedAt: Timestamp.fromMillis(0), id: "" }),
      createPullCheckpoint: ({ snapshot, previousCheckpoint }) =>
        nextCheckpoint(snapshot, previousCheckpoint),

      // 4. Every write stamps updatedAt on the server.
      serializeCreate: (data) => ({ ...data, updatedAt: serverTimestamp(), deleted: false }),
      serializeUpdate: (data) => ({ ...data, updatedAt: serverTimestamp(), deleted: false }),
      serializeDelete: (_id, { deletedAt }) => ({
        deleted: true,
        deletedAt: Timestamp.fromMillis(deletedAt),
        updatedAt: serverTimestamp(),
      }),

      // 5. Turn Firestore timestamps back into the numbers your table stores.
      deserializeCreate: (data) => ({ ...data, updatedAt: toMillis(data.updatedAt) }) as Todo,
      deserializeUpdate: (data) => ({ ...data, updatedAt: toMillis(data.updatedAt) }) as Todo,
    }),
  ],

  // 6. Checkpoints are stored as JSON, which reads a Timestamp back as a plain
  //    { seconds, nanoseconds } object: rebuild it for startAfter.
  checkpointSerializer: {
    serialize: (checkpoint) => JSON.stringify(checkpoint),
    deserialize: (value) => {
      const { updatedAt, id } = JSON.parse(value);
      return { updatedAt: new Timestamp(updatedAt.seconds, updatedAt.nanoseconds), id };
    },
  },
});

function toMillis(value: unknown): number {
  return value instanceof Timestamp ? value.toMillis() : Number(value ?? 0);
}

// The adapter types `client.getCheckpoint`; its serializer keeps the Timestamp.
const client = createSyncClient({ collections: [todosCollection], dbAdapter, syncAdapter });
```

Why each piece matters:

- **Ordering by `updatedAt` and then by document id** makes the order stable even when two documents have the same timestamp. `startAfter(updatedAt, id)` then continues exactly after the last document seen.
- **Server timestamps** come from one clock, so a device with a wrong clock cannot hide its changes.
- **Deletes must update `updatedAt` too**, or they would never match the query.
- **A checkpoint holding a `Timestamp` needs a `checkpointSerializer`.** Without one it is stored with `JSON.stringify` / `JSON.parse`, and the next pull would pass a plain object to `startAfter`.
- The query on two fields needs a **composite index** in Firestore. The first time it runs, the Firestore error message contains a link that creates it.

The complete version of this setup is in the [Drizzle + Firestore example](../../examples/todo-react-drizzle-firestore/src/sync.ts).

## Deletes

A local delete does not remove the Firestore document. By default it writes a **tombstone** with `merge: true`:

```json
{ "deleted": true, "deletedAt": 1767225600000 }
```

Other devices then see the document change, notice `deleted: true`, and delete their local row. A real document removal would be invisible to a device that was offline when it happened.

You can change both sides:

- `serializeDelete(id, { deletedAt })`: the data written for a delete.
- `isDeleted(data, { snapshot })`: whether a pulled document is a tombstone (default: `data.deleted === true`).
- `resolveDeletedAt(data, { snapshot })`: the delete time in milliseconds (default: `data.deletedAt`, as a number or a `Timestamp`).
- `deserializeDeleteId({ snapshot })`: the local primary key of a deleted document (default: the document id).

Remember to **filter tombstones out** if other parts of your system read Firestore directly. Clean them up from a server job once every device has had time to sync.

## Mapping data

By default the local record is written as-is, and a pulled document is used as-is. Use the hooks to change that:

| Option                                  | Direction | Use it to...                                                   |
| --------------------------------------- | --------- | -------------------------------------------------------------- |
| `serializeCreate(data)`                 | push      | shape a new document, add server timestamps, drop local fields |
| `serializeUpdate(data)`                 | push      | shape a partial update (it is merged into the document)        |
| `serializeDelete(id, { deletedAt })`    | push      | shape the tombstone                                            |
| `deserializeCreate(data, { snapshot })` | pull      | turn a new document into a local record                        |
| `deserializeUpdate(data, { snapshot })` | pull      | turn a changed document into a local record                    |
| `resolveRemoteId(event)`                | push      | **required**: the Firestore document id of a local change      |

Pulled records must contain the collection's **primary key** field. If your documents do not store it, add it in `deserializeCreate` / `deserializeUpdate`, for example `({ ...data, id: snapshot.id })`.

## Per-user data

Put each user's data under their own path:

```ts
defineFirestoreCollectionSyncAdapterConfig({
  collectionConfig: todosCollection,
  collectionPath: `users/${user.uid}/todos`,
  // ...
});
```

The path is fixed when the adapter is created, so create the sync client after sign-in. When the user changes, `dispose()` the old client and create a new one, ideally on a new storage `key` per user.

## Security rules and errors

Firestore checks every write against your security rules. When a write is refused, the adapter tells EzSync whether retrying could help:

| Firestore error code                                                           | EzSync does                                                                                          |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `permission-denied`, `invalid-argument`, `out-of-range`, `failed-precondition` | **Parks** the write and reports it with `onPushRejected`. See [Rejected writes](rejected-writes.md). |
| `unauthenticated`, `unavailable`, `deadline-exceeded`, others                  | Retries with backoff.                                                                                |

A user who is signed out typically gets `permission-denied`: their writes are parked, not lost. Call `client.retryRejectedPushes()` after sign-in.

Pulls that fail (for example a listener refused by rules, or a missing index) are retried with backoff and reported through the sync status.

## One collection only

If you prefer to attach the adapter to a single collection's definition, use `createFirestoreCollectionSyncAdapter`. It takes the same options plus `db` and an optional `collectionName` (defaults to the last segment of `collectionPath`). See the [API reference](../api/sync-firebase.md#createfirestorecollectionsyncadapterconfig).

## Good to know

- **Pushes may repeat.** If the network fails after Firestore saved a batch, the batch is sent again. A `set` of the same data is harmless, so this is safe.
- **Offline persistence of the Firebase SDK is not needed.** EzSync already keeps everything locally. Plain `getFirestore()` is enough.
- `includeMetadataChanges` (on the adapter or per collection) is passed to `onSnapshot`. Leave it off unless you know you need it.
