# `@ez-kits/sync-client-storage-wa-sqlite`

[wa-sqlite](https://github.com/powersync-ja/wa-sqlite) (the maintained `@journeyapps/wa-sqlite` build) in a leader worker. You choose where the database is saved: the Origin Private File System (`OPFSCoopSyncVFS`) or IndexedDB (`IDBBatchAtomicVFS`). No COOP/COEP headers needed. Dialect: `sqlite`.

```bash
npm install @ez-kits/sync-client-storage-wa-sqlite @journeyapps/wa-sqlite
```

| Entry point                                     | Use it in  | Contents                                        |
| ----------------------------------------------- | ---------- | ----------------------------------------------- |
| `@ez-kits/sync-client-storage-wa-sqlite`        | the page   | `createWaSqliteDBStorage`                       |
| `@ez-kits/sync-client-storage-wa-sqlite/worker` | the worker | `openWaSqliteEngine`, `destroyWaSqliteDatabase` |

Setup walkthrough: [Choosing a storage engine → wa-sqlite](../guides/storage-engines.md#wa-sqlite).

## `createWaSqliteDBStorage(options)`

```ts
function createWaSqliteDBStorage(options: WaSqliteDBStorageOptions): DBStorage;
```

`createWorkerDBStorage` with `dialect: "sqlite"`. Takes `worker`, `key`, `engineOptions`, `requestTimeoutMs` and `transactionTimeoutMs`, like [`createWorkerDBStorage`](client-core.md#createworkerdbstorageoptions).

### `WaSqliteEngineOptions`

| Option     | Type                                | Default  | Description                                                                                                  |
| ---------- | ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `filename` | `string`                            | required | The database file, e.g. `my-app.sqlite3`. A path in OPFS; with `indexeddb` also the IndexedDB database name. |
| `vfs`      | `"opfs" \| "indexeddb" \| "memory"` | `"opfs"` | Where the database is saved. `memory` keeps it in memory.                                                    |

## `openWaSqliteEngine(options)`

```ts
function openWaSqliteEngine(options: OpenWaSqliteEngineOptions): Promise<WaSqliteEngine>;
```

Takes `WaSqliteEngineOptions` plus `loadModule?: (build: "sync" | "async") => Promise<unknown>`. It loads the Emscripten module, for example to pass `locateFile` or `wasmBinary`. By default it loads `dist/wa-sqlite.mjs` for `opfs` and `memory`, and `dist/wa-sqlite-async.mjs` for `indexeddb`, because `IDBBatchAtomicVFS` needs the asynchronous build.

Returns a `WaSqliteEngine`: a `DBEngine` with `sqlite3`, the wa-sqlite API, and `db`, the database handle. `close()` closes the database and the VFS, so the next leader's worker can open it.

## `destroyWaSqliteDatabase(options)`

```ts
function destroyWaSqliteDatabase(options: WaSqliteEngineOptions): Promise<void>;
```

With `opfs`, it removes `filename` and its journal files (`-journal`, `-wal`) from OPFS. With `indexeddb`, it deletes the IndexedDB database `filename`. It does nothing for `vfs: "memory"` or a missing database. Pass it to the worker to enable `DBStorage.destroy()` and `client.destroy()`:

```ts
startDBStorageWorker<WaSqliteEngineOptions>({ open: ..., destroy: destroyWaSqliteDatabase });
```

With Vite, add `optimizeDeps: { exclude: ["@journeyapps/wa-sqlite"] }` to `vite.config.ts`.

## Types

`WaSqliteDBStorageOptions`, `WaSqliteEngineOptions` (both entry points), `OpenWaSqliteEngineOptions`, `WaSqliteEngine` (`/worker`).
