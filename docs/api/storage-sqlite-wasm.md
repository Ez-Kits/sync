# `@ez-kits/sync-storage-sqlite-wasm`

The official [SQLite WASM](https://sqlite.org/wasm) build in a leader worker, saved to the Origin Private File System with the `opfs-sahpool` VFS. No COOP/COEP headers needed. Dialect: `sqlite`.

```bash
npm install @ez-kits/sync-storage-sqlite-wasm @sqlite.org/sqlite-wasm
```

| Entry point                                | Use it in  | Contents                  |
| ------------------------------------------ | ---------- | ------------------------- |
| `@ez-kits/sync-storage-sqlite-wasm`        | the page   | `createSqliteWasmStorage` |
| `@ez-kits/sync-storage-sqlite-wasm/worker` | the worker | `openSqliteWasmEngine`    |

Setup walkthrough: [Choosing a storage engine → SQLite WASM](../guides/storage-engines.md#sqlite-wasm).

## `createSqliteWasmStorage(options)`

```ts
function createSqliteWasmStorage(options: SqliteWasmStorageOptions): DBStorage;
```

`createWorkerDBStorage` with `dialect: "sqlite"`. Takes `worker`, `key`, `engineOptions`, `requestTimeoutMs` and `transactionTimeoutMs`, like [`createWorkerDBStorage`](client-core.md#createworkerdbstorageoptions).

### `SqliteWasmEngineOptions`

| Option     | Type                         | Default          | Description                                                          |
| ---------- | ---------------------------- | ---------------- | -------------------------------------------------------------------- |
| `filename` | `string`                     | required         | The database file inside the pool, e.g. `/my-app.sqlite3`.           |
| `vfs`      | `"opfs-sahpool" \| "memory"` | `"opfs-sahpool"` | `memory` keeps the database in memory.                               |
| `poolName` | `string`                     | `"ez-sync"`      | The OPFS pool. Use different names for different apps on one origin. |

## `openSqliteWasmEngine(options)`

```ts
function openSqliteWasmEngine(options: OpenSqliteWasmEngineOptions): Promise<SqliteWasmEngine>;
```

Takes `SqliteWasmEngineOptions` plus `sqlite3?: Sqlite3Static | Promise<Sqlite3Static>` (a loaded SQLite module; default: the package's own build).

Returns a `SqliteWasmEngine`: a `DBEngine` with `database`, the underlying `oo1` database. `close()` closes the database and pauses the pool, so the next leader's worker can open it.

With Vite, add `optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] }` to `vite.config.ts`.

## Types

`SqliteWasmStorageOptions`, `SqliteWasmEngineOptions` (both entry points), `OpenSqliteWasmEngineOptions`, `SqliteWasmEngine` (`/worker`).
