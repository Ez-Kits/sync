# Sync with Realtime Database

`@ez-kits/sync-firebase/sync-realtime-db` syncs your collections with the Firebase Realtime Database (RTDB). Each local record is one child node under the collection's path: `<collectionPath>/<recordId>`.

```bash
npm install @ez-kits/sync-firebase firebase
```

## The smallest setup

```ts
import {
  createRealtimeDBSyncAdapter,
  defineRealtimeDBCollectionSyncAdapterConfig,
} from "@ez-kits/sync-firebase/sync-realtime-db";
import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const database = getDatabase(initializeApp(firebaseConfig));

const syncAdapter = createRealtimeDBSyncAdapter({
  db: database,
  collections: [
    defineRealtimeDBCollectionSyncAdapterConfig({
      collectionConfig: todosCollection,
      collectionPath: "todos",
      resolveRecordId: (event) =>
        event.type === "delete" ? String(event.id) : String(event.data.id),
      createCheckpoint: () => null,
    }),
  ],
});

const client = createSyncClient({ collections: [todosCollection], dbAdapter, syncAdapter });
client.startSync();
```

What this does:

- **Push**: a create replaces the record node; an update merges the changed fields into it; a delete merges a tombstone (`deleted: true`, `deletedAt`). All writes of one push go out as **one multipath `update`** where possible, and several writes to the same record are folded into one.
- **Pull**: listens with `onChildAdded`, `onChildChanged` and `onChildRemoved` on the collection path, and applies each change.

## Pull only what changed

Narrow the listener with `buildRealtimePullQuery`, and remember where you stopped with `createPullCheckpoint`:

```ts
import { orderByChild, query, ref, serverTimestamp, startAt } from "firebase/database";

defineRealtimeDBCollectionSyncAdapterConfig({
  collectionConfig: todosCollection, // its checkpoint type is `number`
  collectionPath: "todos",
  resolveRecordId: (event) => (event.type === "delete" ? String(event.id) : String(event.data.id)),

  buildRealtimePullQuery: ({ db, collectionPath, checkpoint }) =>
    query(ref(db, collectionPath), orderByChild("updatedAt"), startAt(checkpoint ?? 0)),
  createCheckpoint: () => 0,
  createPullCheckpoint: ({ snapshot, previousCheckpoint }) =>
    Math.max(previousCheckpoint ?? 0, Number(snapshot.val()?.updatedAt ?? 0)),

  serializeCreate: (data) => ({ ...data, updatedAt: serverTimestamp() }),
  serializeUpdate: (data) => ({ ...data, updatedAt: serverTimestamp() }),
  serializeDelete: (_id, { deletedAt }) => ({
    deleted: true,
    deletedAt,
    updatedAt: serverTimestamp(),
  }),
});
```

- `startAt` includes the checkpoint value itself, so the last record is pulled once more. That is harmless (it is applied again), and it means records with the same `updatedAt` are not missed.
- Add an index on `updatedAt` in your database rules (`".indexOn": ["updatedAt"]`) so the query is efficient.

## Deletes

Like the Firestore adapter, deletes are **tombstones** by default: the node gets `deleted: true` and `deletedAt` (milliseconds) merged in, and stays. Other devices see the change and delete their local row. A node that is really removed (`onChildRemoved`) is also applied as a delete.

Change this with `serializeDelete`, `isDeleted`, `resolveDeletedAt` and `deserializeDeleteId`; they work like their [Firestore counterparts](firestore.md#deletes).

## Mapping data

| Option                                  | Direction | Use it to...                                  |
| --------------------------------------- | --------- | --------------------------------------------- |
| `resolveRecordId(event)`                | push      | **required**: the child key of a local change |
| `serializeCreate(data)`                 | push      | shape the node written for a create           |
| `serializeUpdate(data)`                 | push      | shape the fields merged for an update         |
| `serializeDelete(id, { deletedAt })`    | push      | shape the tombstone                           |
| `deserializeCreate(data, { snapshot })` | pull      | turn an added node into a local record        |
| `deserializeUpdate(data, { snapshot })` | pull      | turn a changed node into a local record       |

Pulled records must contain the collection's primary key. If your nodes do not store it, add it: `deserializeCreate: (data, { snapshot }) => ({ ...(data as object), id: snapshot.key })`.

Record ids must be valid RTDB keys: no `.`, `#`, `$`, `[`, `]` or `/`. UUIDs are fine.

## Security rules and errors

| Error                                                  | EzSync does                                               |
| ------------------------------------------------------ | --------------------------------------------------------- |
| `PERMISSION_DENIED` (rules or `.validate` refused it)  | **Parks** the write and reports it with `onPushRejected`. |
| An invalid path or value refused by the SDK right away | **Parks** the write.                                      |
| Anything else (`DISCONNECTED`, `EXPIRED_TOKEN`, ...)   | Retries with backoff.                                     |

See [Rejected writes](rejected-writes.md). Because one multipath update is all-or-nothing, a refused update fails every write in it. EzSync then splits the push into smaller pieces until it finds the refused write, and pushes the others.

## One collection only

`createRealtimeDBCollectionSyncAdapter({ db, collectionPath, collectionName?, ...options })` builds an adapter for a single collection, to pass as that collection's `syncAdapter`. See the [API reference](../api/sync-firebase.md#createrealtimedbcollectionsyncadapterconfig).
