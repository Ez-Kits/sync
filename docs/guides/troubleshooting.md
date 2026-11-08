# Troubleshooting

Find your symptom or error name below.

## Errors

### `Sync clients require a database adapter with a DB storage and an atomic local-change store.`

`createSyncClient` received something that is not a complete DB adapter. Pass the result of `createDrizzleSqliteDBAdapter`, `createDrizzlePgDBAdapter`, `createTypeOrmSqliteDBAdapter` or `createTypeOrmPgDBAdapter`. If you wrote your own adapter, check it against [Custom DB adapter](../extending/custom-db-adapter.md).

### `The Drizzle adapter is built for sqlite but the storage speaks postgres.` (or the reverse)

The adapter and the storage use different SQL dialects. Use the `/sqlite` adapter with sql.js or SQLite WASM, and the `/pg` adapter with PGlite.

### `CoordinationUnavailableError`

The browser (or environment) has no Web Locks or BroadcastChannel, which multi-tab storage needs. This happens in very old browsers, some embedded web views, and Node. Use `createLocalDBStorage` there; see [Node.js and tests](node-and-tests.md).

### `TransactionStatementError: Use DBStorage.transaction (or the adapter's transaction) instead of BEGIN/COMMIT.`

Some code sent `BEGIN`, `COMMIT`, `ROLLBACK` or `END` as a statement. Transactions must go through `dbAdapter.transaction(fn)` or `dbStorage.transaction(fn)`. With Drizzle, do not call `db.transaction()`. Savepoints inside a transaction (`SAVEPOINT`, `ROLLBACK TO`) are allowed.

### `TransactionClosedError`

A transaction stayed idle for longer than `transactionTimeoutMs` (10 seconds by default) and was rolled back. Common causes:

- Inside a transaction (or a conflict resolver), the code awaited a query that does **not** go through the transaction. That query waits for the transaction to end, and the transaction waits for the query: a deadlock until the timeout. Inside `dbAdapter.transaction((tx, context) => ...)`, use `tx` and `context.native` only.
- The code awaited something slow (a network call, user input) in the middle of a transaction. Do that before or after.

### `LeaderChangedError` / `LeaderUnavailableError`

The leader tab closed or crashed while a request was in flight, or could not be reached. Both are retriable. EzSync already retries local writes for you. If your own code calls `dbStorage.exec` / `transaction` directly, retry on these errors (both have `retriable: true`).

### `DBStorageClosedError`

The storage was closed with `client.dispose()` or `dbStorage.close()`. Create a new storage and client.

### `DBStorageDestroyedError`

The database was deleted with `client.destroy()` or `dbStorage.destroy()`, maybe in another tab. Watch for it with `client.subscribeDestroyed()`, for example to send the user to sign-in. Create a new storage and client to start over.

### `DBStorageDestroyUnsupportedError`

`destroy()` needs the storage worker to know how to delete its database. Pass `{ open, destroy }` to `startDBStorageWorker`, with the storage package's `destroy...Database` function. See [Choosing a storage engine](storage-engines.md).

### `PendingWritesError`

`client.destroy()` refused to delete writes that were not pushed yet. Wait for them with `waitForPushed()`, or pass `ifPendingWrites: "discard"` once the user agreed to lose them.

### `Primary field not found`

`defineDrizzleCollection` could not find a primary key column in the table, or `defineTypeOrmCollection` found no `@PrimaryColumn`. Mark one column as the primary key, or pass `primaryField` (a list of fields for a composite key).

### `Primary field mismatch: metadata has "x", expected "y"`

The `primaryField` given to `defineTypeOrmCollection` does not name exactly the entity's primary columns (in any order, each once).

### `Update requires primary field "id"`

`collections.<name>.update(...)` was called without the primary key (or one of its fields, for a composite key). TypeScript catches this; it happens from untyped code. Pass the key along with the changed fields.

### `Collection "items" has a composite primary key: pass deserializeDeleteId ...`

A Firebase collection config for a composite key has no `deserializeDeleteId`. Add one that rebuilds the key object from the deleted document's id.

### `Row not found in "todos" for id ...`

`collections.<name>.get(id)` found no record. Use `getMany` or a live query if the record may be missing.

### `no such table: todos` (or `relation "todos" does not exist`)

Your table was never created. EzSync does not create application tables. Add a `CREATE TABLE IF NOT EXISTS` to the migrations you run in the storage worker; see [Your database schema](database-schema.md).

## Behaviour

### Writes are not reaching the backend

Check, in order:

1. `client.startSync()` was called.
2. The status (`client.subscribeStatus`) is `syncing` in the leader tab, or `idle` in followers. `offline` means the browser thinks it is offline. `error` holds the cause.
3. The writes go through `client.collections.*`. Writes made with the ORM directly are not synced.
4. `onPushRejected` is not reporting refusals (security rules, signed-out user). See [Rejected writes](rejected-writes.md).
5. A sync adapter is configured for that collection.

### Remote changes do not appear

1. Sync is running (see above).
2. For Firestore with `buildPullQueryConstraints`: every write must set the field you order by (for example `updatedAt`), deletes included, and the composite index must exist.
3. The pulled data contains the collection's primary key field. If not, add it in `deserializeCreate` / `deserializeUpdate`.
4. The record does not have unpushed local writes. If it does, it is a conflict, and by default local wins. See [Conflict resolution](conflict-resolution.md).
5. To force a full re-pull of a collection: `await client.saveCheckpoint("todos", undefined)`, then `stopSync()` and `startSync()`. A record with unpushed local writes keeps its local state until they are pushed.

### Only one tab syncs

This is by design. One tab, the **leader**, syncs for all of them. The others show status `idle`. When the leader closes, another tab takes over.

### A live query shows stale results after a prop or state change (React)

`useLiveQuery` restarts only when `collections` or `deps` change. Put every prop and state value its `query` reads in `deps`. See [React](react.md#read-data-with-uselivequery).

### A live query never updates

- It lists `collections` that do not include the collection you write to.
- The writes do not go through `client.collections`.

### The app is slow with sql.js and a large database

sql.js saves the **whole** database to IndexedDB after every commit, which costs more as the database grows. Switch to SQLite WASM; your queries stay the same. See [Choosing a storage engine](storage-engines.md).

### The `.wasm` file fails to load

- sql.js: pass `wasmUrl` to `openSqlJsEngine` (with Vite: `import wasmUrl from "sql.js/dist/sql-wasm.wasm?url"`).
- SQLite WASM and PGlite with Vite: add the package to `optimizeDeps.exclude` in `vite.config.ts`.

### The database failed to open

`dbStorage.ready` rejects and the sync status becomes `error`. Common causes: the `.wasm` file did not load, a migration in the worker threw, or the browser blocks storage (private mode with storage disabled). Check the worker's console. Do not clear browser storage blindly: it deletes unpushed writes.

### The status stays `error` with `LeaderUnavailableError`, or `dbStorage.ready` never settles

The database has not opened within `requestTimeoutMs` (10 seconds by default). The sync status becomes `error` with `LeaderUnavailableError`, while `dbStorage.ready` keeps waiting: the database may still open, and sync then starts by itself. The usual causes are another tab of your app that is frozen or suspended while holding the leader lock (iOS Safari suspends background tabs; close it), or an engine that takes longer to open, for example a slow migration in the worker (raise `requestTimeoutMs`).

### `UnknownError` from OPFS on Safari

`navigator.storage.getDirectory()` rejects with `UnknownError` where WebKit keeps no persistent storage, such as a non-persistent `WKWebView` data store. Private Browsing is the likely case to check. The sync status becomes `error`. Use wa-sqlite's `vfs: "indexeddb"` there, which works without persistent OPFS, but keeps nothing after the session ends.

### `DBStorageWorkerError`: the storage worker failed to load

The storage worker script itself failed to load, for example because an import inside it could not be resolved, or the URL passed to `new Worker(...)` is wrong. `dbStorage.ready` rejects with `DBStorageWorkerError`, `dbStorage.onError` listeners get it, every read and write rejects with it, and the sync status becomes `error`. The browser rarely says why: look for the failed worker request in the Network tab, or for the error in your dev server's terminal (Vite prints `Failed to resolve import ...`). Check that:

- the worker file path in `new URL("./worker.ts", import.meta.url)` is right, relative to the file that contains it;
- the worker imports the engine from the `/worker` entry point (`@ez-kits/sync-client-storage-sqljs/worker`, ...) and the package is installed;
- for SQLite WASM and PGlite with Vite, the package is in `optimizeDeps.exclude`.

### Reset everything during development

Close every tab of the app, then clear the site data in your browser's dev tools (Application → Storage → Clear site data). This deletes local data **including unpushed writes**.

## Still stuck?

Read [How EzSync works](how-it-works.md) for the mental model, or the [architecture decisions](../../architecture.md) for the exact guarantees.
