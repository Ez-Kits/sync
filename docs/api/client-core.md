# `@ez-kits/sync-client-core`

The sync client runtime, the storage helpers, and the contracts every other package implements. It depends on no ORM, engine or backend.

```bash
npm install @ez-kits/sync-client-core
```

```ts
import {
  createSyncClient,
  createLocalDBStorage,
  startDBStorageWorker,
} from "@ez-kits/sync-client-core";
```

**Contents**

- [Sync client](#sync-client): `createSyncClient`, `SyncClientConfig`, `SyncClient`
- [DB storage](#db-storage): `createWorkerDBStorage`, `startDBStorageWorker`, `createLocalDBStorage`, `DBStorage`, `DBEngine`, ...
- [Errors](#errors)
- [Collections](#collections): `CollectionConfig` and type helpers
- [DB adapter contract](#db-adapter-contract): `BaseDBAdapter`, `DBAdapterOperations`
- [Local-change store contract](#local-change-store-contract): `ILocalChangeStore`, `AtomicLocalChangeStore`
- [Sync adapter contract](#sync-adapter-contract): `SyncAdapter`, `PullOptions`, `PushOptions`, `ConflictResolution`, ...
- [Change events](#change-events): `ChangeBusEvent` and related types
- [Low-level exports](#low-level-exports)

---

## Sync client

### `createSyncClient(config)`

```ts
function createSyncClient<C, DB, TCheckpoint>(
  config: SyncClientConfig<C, DB, TCheckpoint>,
): SyncClient<C, DB, TCheckpoint>;
```

Creates the client your app talks to. It starts initializing right away: it waits for `dbAdapter.dbStorage.ready`, then runs `dbAdapter.localChangeStore.initialize()` (which creates EzSync's tables). Every read, write, live query and sync waits for that.

Throws synchronously when `dbAdapter` is not a complete DB adapter (it needs `dbStorage`, `commitLocalMutation` and an atomic `localChangeStore`), or when `syncAdapter.collections` lists a collection that has its own adapter.

### `SyncClientConfig`

| Option                 | Type                                 | Required | Description                                                                                                                                                                      |
| ---------------------- | ------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collections`          | `CollectionConfigMap` (an array)     | yes      | The collections. Must be the same ones passed to the DB adapter.                                                                                                                 |
| `dbAdapter`            | `BaseDBAdapter`                      | yes      | The DB adapter; the client uses its `dbStorage` and `localChangeStore`.                                                                                                          |
| `syncAdapter`          | `SyncAdapter`                        | no       | The backend for the collections it lists in `collections` (all of them when it lists none), except those with their own adapter. Writes no adapter syncs never enter the outbox. |
| `checkpointSerializer` | `CheckpointSerializer`               | no       | How pull checkpoints are stored as strings. Default: the serializer of the adapter that syncs the collection, else JSON.                                                         |
| `resolveConflict`      | `ConflictResolution`                 | no       | Decides conflicts (a remote change for a record with unpushed local writes). Default: local wins. See [Conflict resolution](../guides/conflict-resolution.md).                   |
| `onSyncStatus`         | `(event: SyncStatusEvent) => void`   | no       | Called on every status change.                                                                                                                                                   |
| `onPushRejected`       | `(rejection: PushRejection) => void` | no       | Called once for each write the backend refused for good. See [Rejected writes](../guides/rejected-writes.md).                                                                    |

### `SyncClient`

| Member                                       | Description                                                                                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collections.<name>.insert(data)`            | Insert a record (with its primary key). Resolves when saved locally.                                                                                      |
| `collections.<name>.update(data)`            | Update a record: its primary key plus the changed fields.                                                                                                 |
| `collections.<name>.delete(id)`              | Delete a record by primary key.                                                                                                                           |
| `collections.<name>.get(id)`                 | Read one record. Rejects if missing.                                                                                                                      |
| `collections.<name>.getMany()`               | Read every record of the collection.                                                                                                                      |
| `liveQuery({ collections?, query, onData })` | Run `query(queryBuilder, querySchema)` now and after every change to `collections` (or to any collection when omitted). Returns a function that stops it. |
| `subscribe(cb, options?)`                    | Listen to change events of every collection. Returns an unsubscribe function.                                                                             |
| `subscribe(collection, cb, options?)`        | ...of one collection.                                                                                                                                     |
| `subscribe(collections[], cb, options?)`     | ...of several collections. `options.stream`: `"local"` (writes in this tab), `"remote"` (pulled changes and other tabs' writes) or `"both"` (default).    |
| `startSync()`                                | Start syncing (in a follower: ask the leader to sync). Also listens to `online` / `offline`.                                                              |
| `stopSync()`                                 | Pause syncing. Local reads and writes keep working.                                                                                                       |
| `retryRejectedPushes()`                      | Push parked (rejected) writes now instead of after their backoff, e.g. after sign-in.                                                                     |
| `dispose()`                                  | `Promise<void>`. Stop sync, release the storage and all listeners for good.                                                                               |
| `role`                                       | `"leader"` or `"follower"`. Only the leader syncs.                                                                                                        |
| `subscribeRole(listener)`                    | Called now with the current role, then on every change. Returns an unsubscribe function.                                                                  |
| `subscribeStatus(listener)`                  | Called now with the current `SyncStatusEvent`, then on every change. Returns an unsubscribe function.                                                     |
| `getCheckpoint(collection)`                  | `Promise<TCheckpoint \| undefined>`: the last committed pull checkpoint.                                                                                  |
| `saveCheckpoint(collection, checkpoint)`     | `Promise<void>`: replace it; `undefined` removes it, so the next pull starts from scratch. Takes effect when the collection's pull (re)starts.            |

### `SyncStatusEvent`

```ts
interface SyncStatusEvent {
  status: "stopped" | "starting" | "syncing" | "idle" | "offline" | "error";
  error?: unknown; // when status is "error"; never contains document data
  changedAt: number; // epoch milliseconds
}
```

See [Syncing](../guides/syncing.md#sync-status) for what each status means.

---

## DB storage

A **DB storage** is the shared database: one statement interface that works the same in every tab, whichever tab holds the engine.

### `createWorkerDBStorage(options)`

```ts
function createWorkerDBStorage<TEngineOptions>(
  options: WorkerDBStorageOptions<TEngineOptions>,
): DBStorage;
```

Starts a storage worker for this context. All contexts with the same `key` elect one leader worker, which opens the engine; the others forward to it. The `create...Storage` functions of the storage packages call this for you.

| Option                 | Type                                    | Default     | Description                                                      |
| ---------------------- | --------------------------------------- | ----------- | ---------------------------------------------------------------- |
| `dialect`              | `"sqlite" \| "postgres"`                | required    | The SQL dialect of the engine.                                   |
| `worker`               | `() => Worker \| MessageEndpoint`       | required    | Starts the worker. Its module must call `startDBStorageWorker`.  |
| `key`                  | `string`                                | `"default"` | Contexts with the same key share one database.                   |
| `engineOptions`        | `TEngineOptions` (structured-cloneable) | `undefined` | Passed to the worker's `open` function.                          |
| `requestTimeoutMs`     | `number`                                | `10000`     | How long a follower waits before probing the leader again.       |
| `transactionTimeoutMs` | `number`                                | `10000`     | Idle time after which the leader rolls back an open transaction. |

The storage releases leadership while the page is in the back/forward cache, and rejoins when it is restored.

### `startDBStorageWorker(open, scope?)`

```ts
function startDBStorageWorker<TEngineOptions>(
  open: OpenDBEngine<TEngineOptions>,
  scope?: DBStorageWorkerScope, // defaults to the worker's globalThis
): void;
```

Call once at the top of the worker module. `open(engineOptions, { signal })` runs **only while this worker leads**, so it is the place for your migrations. `signal` is aborted when the worker stops leading.

### `createLocalDBStorage(options)`

```ts
function createLocalDBStorage(options: LocalDBStorageOptions): DBStorage;
```

A storage whose engine runs in this context, which is always the leader. For Node, tests, single-context apps, or engines already shared across tabs.

| Option                 | Type                                                     | Default     |
| ---------------------- | -------------------------------------------------------- | ----------- |
| `dialect`              | `"sqlite" \| "postgres"`                                 | required    |
| `open`                 | `(context: { signal }) => DBEngine \| Promise<DBEngine>` | required    |
| `key`                  | `string`                                                 | `"default"` |
| `transactionTimeoutMs` | `number`                                                 | `10000`     |

### `DBStorage`

```ts
interface DBStorage extends DBExecutor {
  readonly dialect: "sqlite" | "postgres";
  readonly key: string;
  readonly ready: Promise<void>; // this context can query, as leader or follower
  readonly role: "leader" | "follower";
  exec(query: DBQuery): Promise<DBQueryResult>;
  transaction<T>(fn: (tx: DBExecutor) => Promise<T>): Promise<T>;
  onRoleChange(listener: (role: DBRole) => void): () => void;
  onInvalidate(listener: () => void): () => void; // the leader changed: re-read everything
  onError(listener: (error: unknown) => void): () => void; // the engine failed to open, ...
  close(): Promise<void>;
}
```

- `transaction(fn)` runs every statement sent through `tx` in one transaction on the leader. The leader serves nothing else until it ends. The transaction commits when `fn` resolves and rolls back when it throws.
- A statement sent with `exec` while a transaction is open **waits for it to end**. Awaiting such a statement inside `fn` deadlocks until the transaction timeout.
- Never send `BEGIN` / `COMMIT` / `ROLLBACK` / `END` yourself (`TransactionStatementError`).

### `DBQuery`, `DBQueryResult`, `DBExecutor`

```ts
interface DBQuery {
  sql: string;
  params: unknown[];
  method: "run" | "all" | "get"; // run: no rows; all: every row; get: only the first row
  rowMode?: "array" | "object"; // default "array"
}

interface DBQueryResult {
  rows: unknown[]; // "get" callers read rows[0]
  affectedRows?: number;
}

interface DBExecutor {
  exec(query: DBQuery): Promise<DBQueryResult>;
}
```

### `DBEngine`, `OpenDBEngine`, `OpenDBEngineContext`

```ts
interface DBEngine extends DBExecutor {
  flush?(): Promise<void>; // make committed state durable; called after every commit and every write outside one
  close(): Promise<void>;
}

type OpenDBEngine<TOptions> = (
  options: TOptions,
  context: OpenDBEngineContext,
) => DBEngine | Promise<DBEngine>;

interface OpenDBEngineContext {
  readonly signal: AbortSignal; // aborted when this context stops leading
}
```

See [Custom DB storage](../extending/custom-db-storage.md) for the full engine contract.

### Other storage exports

| Export                                                                    | Description                                                                             |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `isTransactionControl(sql)`                                               | `true` for `BEGIN`, `START`, `COMMIT`, `END` and `ROLLBACK` (not `ROLLBACK TO`).        |
| `DBDialect`                                                               | `"sqlite" \| "postgres"`                                                                |
| `DBRole`                                                                  | `"leader" \| "follower"`                                                                |
| `MessageEndpoint`                                                         | `{ postMessage(message): void; onmessage }`: a `Worker`, `MessagePort` or worker scope. |
| `WorkerDBStorageOptions`, `LocalDBStorageOptions`, `DBStorageWorkerScope` | Option types of the functions above.                                                    |

---

## Errors

| Class                          | When                                                                                             | `retriable` |
| ------------------------------ | ------------------------------------------------------------------------------------------------ | ----------- |
| `CoordinationUnavailableError` | Web Locks or BroadcastChannel are missing; `ready` rejects with it.                              |             |
| `LeaderChangedError`           | The leader went away while a write or transaction was in flight. It may or may not have applied. | `true`      |
| `LeaderUnavailableError`       | No live leader answered.                                                                         | `true`      |
| `TransactionClosedError`       | The transaction was rolled back after idling too long, or is otherwise closed.                   |             |
| `TransactionStatementError`    | A `BEGIN` / `COMMIT` / ... statement was sent.                                                   |             |
| `DBStorageClosedError`         | The storage was closed.                                                                          |             |
| `DBStorageWorkerError`         | The storage worker failed to load; `ready` and every request reject with it.                     |             |
| `PushRejectedError`            | Thrown by a sync adapter for a write refused for good. Has `permanent: true`.                    |             |

| Helper                                                   | Description                                                |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| `isRetriableError(error)`                                | `error.retriable === true`                                 |
| `isPermanentPushError(error)`                            | `error.permanent === true`                                 |
| `serializeError(error)` / `deserializeError(serialized)` | Move an error between contexts, keeping the classes above. |

`new PushRejectedError(message?, options?)` takes the standard `ErrorOptions` (`{ cause }`).

---

## Collections

You normally create collections with `defineDrizzleCollection` or `defineTypeOrmCollection`. Their shape:

```ts
interface CollectionConfig<TName, AdapterConfig, UpdateModel, InsertModel, SelectModel, PrimaryField, TCheckpoint> {
  name: TName;
  adapterConfig: AdapterConfig; // adapter-specific, e.g. { table } or { entity }
  primaryField: PrimaryField;
  syncAdapter?: SyncAdapter<...>; // a sync adapter for this collection only
}
```

| Type helper                            | Gives you                                              |
| -------------------------------------- | ------------------------------------------------------ |
| `CollectionConfigMap`                  | An array (or tuple) of collection configs.             |
| `CollectionNames<C>`                   | The union of collection names.                         |
| `ConfigForName<C, N>`                  | The config of collection `N`.                          |
| `InferCollectionInsertModel<Col>`      | What `insert` accepts.                                 |
| `InferCollectionUpdateModel<Col>`      | What `update` accepts.                                 |
| `InferCollectionSelectModel<Col>`      | What `get` returns.                                    |
| `InferCollectionPrimaryFieldType<Col>` | The primary key type.                                  |
| `InferCollectionCheckpoint<Col>`       | The checkpoint type of the collection's own adapter.   |
| `InferCheckpointMap<C>`                | The union of those, over all collections.              |
| `TCollectionRuntime<Col>`              | The `insert / update / delete / get / getMany` object. |
| `TCollectionRuntimeRecord<C>`          | `client.collections`.                                  |

---

## DB adapter contract

Implemented by the Drizzle and TypeORM adapters. Implement it yourself to support another ORM: see [Custom DB adapter](../extending/custom-db-adapter.md).

```ts
interface DBAdapterOperations<C> {
  insert(collection, data): Promise<void>;
  update(collection, data): Promise<void>; // data contains the primary key
  delete(collection, id): Promise<void>;
  get(collection, id): Promise<Row>; // rejects when missing
  getOptional?(collection, id): Promise<Row | undefined>; // undefined only when missing; errors reject
  getMany(collection): Promise<Row[]>;
}

interface DBAdapterTransactionContext<C> {
  operations: DBAdapterOperations<C>; // CRUD inside the transaction
  native: unknown; // the adapter's own transaction handle, passed to the local-change store
}

interface BaseDBAdapter<C, TQueryBuilder, TQuerySchema> extends DBAdapterOperations<C> {
  queryBuilder: TQueryBuilder; // passed to live queries
  querySchema: TQuerySchema; // passed to live queries
  readonly dbStorage: DBStorage;
  readonly localChangeStore: AtomicLocalChangeStore;
  transaction<T>(
    fn: (tx: DBAdapterOperations<C>, context: DBAdapterTransactionContext<C>) => Promise<T>,
  ): Promise<T>;
  commitLocalMutation(options: {
    mutate: (context) => Promise<void>;
    persistOutboxEvent: (context) => Promise<void>;
    persistDirtyRecord: (context) => Promise<void>;
  }): Promise<void>; // runs all three in one transaction
}
```

`LocalMutationTransactionContext<C>` is an alias of `DBAdapterTransactionContext<C>`.

---

## Local-change store contract

The outbox and the sync state stored next to the rows. Every method takes an optional `transactionContext`: the `native` handle of an open adapter transaction. With it, the call runs in that transaction.

```ts
interface ILocalChangeStore<TTx = unknown> {
  initialize(): Promise<void>; // create / upgrade the store's tables; idempotent, safe to run concurrently
  appendEvents(events: StoredChangeBusEvent[], tx?): Promise<void>; // also records each id as applied
  hasAppliedEvent(eventId: string, tx?): Promise<boolean>;
  getPendingEvents(scope?: LocalChangeScope, tx?): Promise<StoredChangeBusEvent[]>; // in commit order
  deleteEvents(ids: string[], tx?): Promise<void>;
  upsertDirtyRecord(record: DirtyRecord, tx?): Promise<void>;
  removeDirtyRecords(keys: DirtyRecordKey[], tx?): Promise<void>;
  getDirtyRecords(scope?: LocalChangeScope, tx?): Promise<DirtyRecord[]>;
  getCheckpoint(collection: string, tx?): Promise<string | undefined>;
  saveCheckpoint(collection: string, value: string | undefined, tx?): Promise<void>; // undefined removes
  getSkippedRemoteEvents(scope?: LocalChangeScope, tx?): Promise<SkippedRemoteEvent[]>;
  upsertSkippedRemoteEvent(entry: SkippedRemoteEvent, tx?): Promise<void>;
  removeSkippedRemoteEvents(keys: DirtyRecordKey[], tx?): Promise<void>;
}

interface AtomicLocalChangeStore<TTx = unknown> extends ILocalChangeStore<TTx> {
  readonly atomicLocalMutationCapability: "atomic";
}
```

| Type                         | Shape                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StoredChangeBusEvent`       | `{ id: string; type: "create" \| "update" \| "delete"; collection: string; data: unknown /* null for deletes */; recordId: string; createdAt: number }` |
| `DirtyRecord`                | `{ collection: string; recordId: string; state: "dirty" \| "deleted"; updatedAt: number }`                                                              |
| `DirtyRecordKey`             | `{ collection: string; recordId: string }`                                                                                                              |
| `DirtyRecordState`           | `"dirty" \| "deleted"`                                                                                                                                  |
| `SkippedRemoteEvent`         | `{ collection: string; recordId: string; event: unknown /* JSON */ }`                                                                                   |
| `LocalChangeScope`           | `string` (a collection) or `DirtyRecordKey` (one record)                                                                                                |
| `APPLIED_EVENT_RETENTION_MS` | `86_400_000` (24 h): how long applied-event ids are kept.                                                                                               |

---

## Sync adapter contract

Implemented by `@ez-kits/sync-firebase`. Implement it yourself for another backend: see [Custom sync adapter](../extending/custom-sync-adapter.md).

```ts
interface SyncAdapter<C, N, TCheckpoint> {
  collections?: readonly N[]; // the collections it syncs; omitted: every one without its own adapter
  checkpointSerializer?: CheckpointSerializer<TCheckpoint>; // how its checkpoints are stored; default JSON
  pull(options: PullOptions<C, N, TCheckpoint>): void | (() => void) | Promise<void | (() => void)>;
  push(options: PushOptions<C, N>): void | Promise<void>;
}

interface PullOptions<C, N, TCheckpoint> {
  checkpoint?: Partial<Record<N, TCheckpoint>>; // the last saved checkpoint of each collection
  commitChanges(options: {
    changes: ChangeBusEvent<C, N>[];
    checkpoint: Partial<Record<N, TCheckpoint>>;
  }): void;
  onError?(error: unknown): void; // report a listener failure; the pull is restarted with backoff
}

interface PushOptions<C, N> {
  events: ChangeBusEvent<C, N>[]; // in commit order
  commitChanges(options: { events: ChangeBusEvent<C, N>[] }): Promise<void>; // acknowledge accepted events
}
```

- `pull` opens a stream of remote changes starting at `checkpoint`. It returns a cleanup function that stops every listener.
- `push` resolves only once the backend durably accepted the events, and calls (and awaits) `commitChanges` for the accepted ones. Throw a `PushRejectedError` for a refusal that resending would meet again; throw anything else to retry.

| Type                                                   | Description                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `CheckpointSerializer<TCheckpoint>`                    | `{ serialize(checkpoint): string; deserialize(value): TCheckpoint }`            |
| `SyncAdapterFor<Collections, TCheckpoint>`             | The `SyncAdapter` for an array of collection configs: their data map and names. |
| `PullCheckpointMap<C, N, TCheckpoint>`                 | `Partial<Record<N, TCheckpoint>>`                                               |
| `PullCommitChangesOptions`, `PushCommitChangesOptions` | The `commitChanges` arguments above.                                            |
| `PushRejection<C, N>`                                  | `{ event: ChangeBusEvent; error: unknown; discard(): Promise<void> }`           |
| `ConflictResolution<C, N>`                             | `({ remote, local }) => "local" \| "remote" \| { data } \| Promise<...>`        |
| `SyncStatus`                                           | `"stopped" \| "starting" \| "syncing" \| "idle" \| "offline" \| "error"`        |

---

## Change events

```ts
type ChangeBusEvent<C, N> =
  | { type: "create"; collection: N; data: C[N]["create"]; eventId?: string }
  | { type: "update"; collection: N; data: C[N]["update"]; eventId?: string }
  | { type: "delete"; collection: N; id: C[N]["delete"]; deletedAt?: number; eventId?: string };
```

`eventId` is set on local events (it identifies the outbox entry). Events produced by a sync adapter's pull leave it out.

| Type                                              | Description                                                                       |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| `ChangeBusEventDataMap`                           | `{ [collection]: { create; update; delete } }`: the payload types per collection. |
| `ChangeBusEventDataMapFromCollectionConfigMap<C>` | That map computed from your collections (adds `record`, the select model).        |
| `ChangeBusListener<C, N>`                         | `(events: ChangeBusEvent<C, N>[]) => void`                                        |
| `ChangeBusStream`                                 | `"local" \| "remote"`                                                             |
| `ChangeBusSubscribeStream`                        | `"local" \| "remote" \| "both"`                                                   |
| `ChangeBusSubscribeOptions`                       | `{ stream?: ChangeBusSubscribeStream }`                                           |

---

## Low-level exports

These are exported for adapter authors and tests. Applications do not need them.

| Export                                                                                                                                                       | Description                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ChangeBus`                                                                                                                                                  | The in-memory event bus the client uses (`publishLocal`, `publishRemote`, `publishLocalBatch`, `publishRemoteBatch`, `subscribe`). |
| `CollectionRuntime`, `CollectionRuntimeStorage`                                                                                                              | The implementation behind `client.collections.<name>`.                                                                             |
| `LocalMutation`, `MutationSink`, `executeLocalMutation`, `isLocalMutationCommitted`, `createLocalMutationSink`, `toStoredChangeBusEvent`, `toChangeBusEvent` | How one local write becomes a row + outbox + dirty-record commit.                                                                  |
| `SyncClientImpl`                                                                                                                                             | The class behind `createSyncClient`.                                                                                               |
| `SyncHandler`, `BaseSyncHandler`, `GlobalSyncHandler`, `CollectionSyncHandler`                                                                               | The pull/push engine run by the leader.                                                                                            |
| `SyncClient`, `SubscribeFn`, `LiveQueryFn`                                                                                                                   | Types of the client and its methods.                                                                                               |
