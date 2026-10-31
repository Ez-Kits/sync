# `@ez-kits/sync-client-firebase`

Sync adapters for **Cloud Firestore** and the **Firebase Realtime Database**. Requires `firebase` `^12.12.1`.

```bash
npm install @ez-kits/sync-client-firebase firebase
```

| Entry point                                      | Contents                   |
| ------------------------------------------------ | -------------------------- |
| `@ez-kits/sync-client-firebase/sync-firestore`   | Firestore adapters         |
| `@ez-kits/sync-client-firebase/sync-realtime-db` | Realtime Database adapters |

There is no root entry point; import from the one you use.

Guides: [Sync with Cloud Firestore](../guides/firestore.md), [Sync with Realtime Database](../guides/realtime-database.md).

---

## Firestore

### `createFirestoreSyncAdapter(config)`

A `SyncAdapter` for several collections, passed to `createSyncClient({ syncAdapter })`.

```ts
createFirestoreSyncAdapter({
  db: firestore,
  includeMetadataChanges: false,
  collections: [defineFirestoreCollectionSyncAdapterConfig({ ... }), ...],
});
```

| Option                   | Type                                     | Description                                                                                                                                                     |
| ------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db`                     | `Firestore`                              | From `getFirestore()`.                                                                                                                                          |
| `collections`            | `FirestoreSyncAdapterCollectionConfig[]` | One per synced collection, from `defineFirestoreCollectionSyncAdapterConfig`. Only these are pushed; writes to other collections without an adapter stay local. |
| `includeMetadataChanges` | `boolean`                                | Default for every collection; passed to `onSnapshot`. Default `false`.                                                                                          |
| `checkpointSerializer`   | `CheckpointSerializer`                   | How checkpoints are stored in the database. Default: the client's JSON, which turns `Timestamp`s into plain objects.                                            |

### `defineFirestoreCollectionSyncAdapterConfig(config)`

Maps one EzSync collection to one Firestore collection, with types inferred from the collection. The checkpoint type is inferred from `createCheckpoint` / `createPullCheckpoint`. Checkpoints are stored with the client's `JSON.stringify` / `JSON.parse` unless the adapter is given a `checkpointSerializer`; give one when the checkpoint holds a `Timestamp`.

| Option                                                   | Type                     | Required | Description                                                                          |
| -------------------------------------------------------- | ------------------------ | -------- | ------------------------------------------------------------------------------------ |
| `collectionConfig`                                       | your collection          | yes      | The EzSync collection (from `defineDrizzleCollection` / `defineTypeOrmCollection`).  |
| `collectionPath`                                         | `string`                 | yes      | Firestore collection path: `"todos"`, `"users/uid/todos"`.                           |
| `resolveRemoteId(event)`                                 | `(event) => string`      | yes      | The document id of a local change (create, update or delete).                        |
| `createCheckpoint()`                                     | `() => TCheckpoint`      | yes      | The checkpoint used when `createPullCheckpoint` is not set.                          |
| `buildPullQueryConstraints({ checkpoint })`              | `=> QueryConstraint[]`   | no       | Narrow the pull query, e.g. `orderBy` + `startAfter`. Default: the whole collection. |
| `createPullCheckpoint({ snapshot, previousCheckpoint })` | `=> TCheckpoint`         | no       | The checkpoint to save after a snapshot.                                             |
| `includeMetadataChanges`                                 | `boolean`                | no       | Overrides the adapter-level option.                                                  |
| `serializeCreate(data)`                                  | `=> DocumentData`        | no       | Document written for a create (`set`). Default: `data`.                              |
| `serializeUpdate(data)`                                  | `=> DocumentData`        | no       | Fields merged for an update (`set` with `merge`). Default: `data`.                   |
| `serializeDelete(id, { deletedAt })`                     | `=> DocumentData`        | no       | Fields merged for a delete. Default: `{ deleted: true, deletedAt }`.                 |
| `deserializeCreate(data, { snapshot })`                  | `=> InsertModel`         | no       | Local record for an added document. Default: `data`.                                 |
| `deserializeUpdate(data, { snapshot })`                  | `=> UpdateModel`         | no       | Local record for a modified document. Default: `data`.                               |
| `deserializeDeleteId({ snapshot })`                      | `=> PrimaryKey`          | no       | Local id of a deleted document. Default: `snapshot.id`.                              |
| `isDeleted(data, { snapshot })`                          | `=> boolean`             | no       | Whether a document is a tombstone. Default: `data.deleted === true`.                 |
| `resolveDeletedAt(data, { snapshot })`                   | `=> number \| undefined` | no       | Delete time in ms. Default: `data.deletedAt` (number or `Timestamp`), else now.      |

### `createFirestoreCollectionSyncAdapter(config)`

A `SyncAdapter` for **one** collection, to pass as that collection's `syncAdapter`. Takes the handler options above (without `collectionConfig`) plus:

| Option                   | Type                   | Description                                                                |
| ------------------------ | ---------------------- | -------------------------------------------------------------------------- |
| `db`                     | `Firestore`            | Required.                                                                  |
| `collectionPath`         | `string`               | Required.                                                                  |
| `collectionName`         | `string`               | The EzSync collection name. Default: the last segment of `collectionPath`. |
| `includeMetadataChanges` | `boolean`              | Passed to `onSnapshot`.                                                    |
| `checkpointSerializer`   | `CheckpointSerializer` | Default: the client's JSON.                                                |

### Behaviour

- **Push:** one `set` per event, in batches of up to 500 writes. Each batch is acknowledged before the next one commits.
- **Pull:** one `onSnapshot` listener per collection. Removed documents and tombstones become delete events; added documents become creates; modified documents become updates.
- **Errors:** `permission-denied`, `invalid-argument`, `out-of-range` and `failed-precondition` are thrown as `PushRejectedError` (the write is parked). Everything else is retried.

---

## Realtime Database

### `createRealtimeDBSyncAdapter(config)`

```ts
createRealtimeDBSyncAdapter({
  db: database, // from getDatabase()
  collections: [defineRealtimeDBCollectionSyncAdapterConfig({ ... }), ...],
});
```

`checkpointSerializer` (optional) sets how checkpoints are stored in the database. Default: the client's `JSON.stringify` / `JSON.parse`.

### `defineRealtimeDBCollectionSyncAdapterConfig(config)`

| Option                                                   | Type                     | Required | Description                                                                                                                   |
| -------------------------------------------------------- | ------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `collectionConfig`                                       | your collection          | yes      | The EzSync collection.                                                                                                        |
| `collectionPath`                                         | `string`                 | yes      | The RTDB path holding the records: `"todos"`, `"users/uid/todos"`.                                                            |
| `resolveRemoteId(event)`                                 | `(event) => string`      | yes      | The child key of a local change.                                                                                              |
| `createCheckpoint()`                                     | `() => TCheckpoint`      | yes      | The checkpoint used when `createPullCheckpoint` is not set.                                                                   |
| `buildPullQuery({ db, collectionPath, checkpoint })`     | `=> Query`               | no       | Narrow the listener, e.g. `query(ref(db, path), orderByChild("updatedAt"), startAt(cp))`. Default: `ref(db, collectionPath)`. |
| `createPullCheckpoint({ snapshot, previousCheckpoint })` | `=> TCheckpoint`         | no       | The checkpoint to save after each child event.                                                                                |
| `serializeCreate(data)`                                  | `=> unknown`             | no       | Value written for a create (replaces the node).                                                                               |
| `serializeUpdate(data)`                                  | `=> unknown`             | no       | Fields merged for an update.                                                                                                  |
| `serializeDelete(id, { deletedAt })`                     | `=> unknown`             | no       | Fields merged for a delete. Default: `{ deleted: true, deletedAt }`.                                                          |
| `deserializeCreate(data, { snapshot })`                  | `=> InsertModel`         | no       | Local record for an added child.                                                                                              |
| `deserializeUpdate(data, { snapshot })`                  | `=> UpdateModel`         | no       | Local record for a changed child.                                                                                             |
| `deserializeDeleteId({ snapshot })`                      | `=> PrimaryKey`          | no       | Default: `snapshot.key`.                                                                                                      |
| `isDeleted(data, { snapshot })`                          | `=> boolean`             | no       | Default: `data.deleted === true`.                                                                                             |
| `resolveDeletedAt(data, { snapshot })`                   | `=> number \| undefined` | no       | Default: `data.deletedAt`, else now.                                                                                          |

### `createRealtimeDBCollectionSyncAdapter(config)`

A `SyncAdapter` for one collection. Takes the handler options above plus `db`, `collectionPath`, optional `collectionName` (default: the last segment of `collectionPath`) and optional `checkpointSerializer`.

### Behaviour

- **Push:** the events of a push are coalesced per record and written with one multipath `update(ref(db), ...)`; a new update starts when paths would nest. Each update is acknowledged before the next.
- **Pull:** `onChildAdded`, `onChildChanged` and `onChildRemoved` on the listen target.
- **Errors:** `PERMISSION_DENIED` and synchronous SDK validation errors are thrown as `PushRejectedError`. Everything else is retried.

---

## Types

| Firestore (`/sync-firestore`)               | Realtime Database (`/sync-realtime-db`)      |
| ------------------------------------------- | -------------------------------------------- |
| `FirestoreSyncAdapterConfig`                | `RealtimeDBSyncAdapterConfig`                |
| `FirestoreSyncCommonAdapterConfig`          | `RealtimeDBSyncCommonAdapterConfig`          |
| `FirestoreCollectionSyncAdapterConfigInput` | `RealtimeDBCollectionSyncAdapterConfigInput` |
| `FirestoreSyncAdapterCollectionConfig`      | `RealtimeDBSyncAdapterCollectionConfig`      |
| `FirestoreSyncAdapterCollectionHandlers`    | `RealtimeDBSyncAdapterCollectionHandlers`    |
| `FirestoreCollectionSyncAdapterConfig`      | `RealtimeDBCollectionSyncAdapterConfig`      |
