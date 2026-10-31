# `@ez-kits/sync-storage-sqljs`

SQLite ([sql.js](https://sql.js.org)) in a leader worker, saved to IndexedDB as a snapshot after every commit. Dialect: `sqlite`.

```bash
npm install @ez-kits/sync-storage-sqljs sql.js
npm install -D @types/sql.js
```

| Entry point                          | Use it in            | Contents                         |
| ------------------------------------ | -------------------- | -------------------------------- |
| `@ez-kits/sync-storage-sqljs`        | the page             | `createSqlJsDBStorage`           |
| `@ez-kits/sync-storage-sqljs/worker` | the worker (or Node) | `openSqlJsEngine`, `sqlJsConfig` |

Setup walkthrough: [Choosing a storage engine → sql.js](../guides/storage-engines.md#sqljs).

## `createSqlJsDBStorage(options)`

```ts
function createSqlJsDBStorage(options: SqlJsDBStorageOptions): DBStorage;
```

`createWorkerDBStorage` with `dialect: "sqlite"`. Options:

| Option                 | Type                 | Default     | Description                                                                             |
| ---------------------- | -------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `worker`               | `() => Worker`       | required    | Starts your worker module, which calls `startDBStorageWorker(... openSqlJsEngine ...)`. |
| `key`                  | `string`             | `"default"` | Tabs with the same key share the database.                                              |
| `engineOptions`        | `SqlJsEngineOptions` | `{}`        | Sent to the worker.                                                                     |
| `requestTimeoutMs`     | `number`             | `10000`     | See [`createWorkerDBStorage`](client-core.md#createworkerdbstorageoptions).             |
| `transactionTimeoutMs` | `number`             | `10000`     | See [`createWorkerDBStorage`](client-core.md#createworkerdbstorageoptions).             |

### `SqlJsEngineOptions`

| Option          | Type     | Description                                                                            |
| --------------- | -------- | -------------------------------------------------------------------------------------- |
| `wasmUrl`       | `string` | URL of `sql-wasm.wasm`. Usually set in the worker from a bundler asset import instead. |
| `indexedDBName` | `string` | Name of the IndexedDB database holding the snapshot. Omit for an in-memory database.   |

## `openSqlJsEngine(options?)`

```ts
function openSqlJsEngine(options?: OpenSqlJsEngineOptions): Promise<SqlJsEngine>;
```

Opens sql.js, restoring the last snapshot from IndexedDB when `indexedDBName` is set. Takes `SqlJsEngineOptions` plus:

| Option             | Type                                  | Description                                                                                      |
| ------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `sqlJs`            | `SqlJsStatic \| Promise<SqlJsStatic>` | A loaded sql.js module (for example a custom build). Default: `initSqlJs(sqlJsConfig(wasmUrl))`. |
| `indexedDBFactory` | `IDBFactory`                          | Default: `globalThis.indexedDB`. Useful with `fake-indexeddb` in tests.                          |

Returns a `SqlJsEngine`: a [`DBEngine`](client-core.md#dbengine-opendbengine-opendbenginecontext) with `database`, the underlying sql.js `Database`.

Behaviour:

- `flush()` saves a new snapshot. The storage calls it after every commit and every write outside a transaction.
- A `run` statement **without parameters** may contain several statements.
- Parameters: `undefined` becomes `NULL`, booleans become `1` / `0`, bigints become numbers.

## `sqlJsConfig(wasmUrl)`

Returns the sql.js init config `{ locateFile: () => wasmUrl }`, or `undefined` when `wasmUrl` is `undefined`.

## Types

`SqlJsDBStorageOptions`, `SqlJsEngineOptions` (both entry points), `OpenSqlJsEngineOptions`, `SqlJsEngine` (`/worker`).
