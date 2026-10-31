# `@ez-kits/sync-storage-pglite`

Postgres ([PGlite](https://pglite.dev)) in a leader worker, persisted to IndexedDB. Dialect: `postgres`.

```bash
npm install @ez-kits/sync-storage-pglite @electric-sql/pglite
```

| Entry point                           | Use it in            | Contents                |
| ------------------------------------- | -------------------- | ----------------------- |
| `@ez-kits/sync-storage-pglite`        | the page             | `createPGliteDBStorage` |
| `@ez-kits/sync-storage-pglite/worker` | the worker (or Node) | `openPGliteEngine`      |

Setup walkthrough: [Choosing a storage engine → PGlite](../guides/storage-engines.md#pglite).

## `createPGliteDBStorage(options)`

```ts
function createPGliteDBStorage(options: PGliteDBStorageOptions): DBStorage;
```

`createWorkerDBStorage` with `dialect: "postgres"`. Takes `worker`, `key`, `engineOptions`, `requestTimeoutMs` and `transactionTimeoutMs`, like [`createWorkerDBStorage`](client-core.md#createworkerdbstorageoptions).

### `PGliteEngineOptions`

| Option    | Type     | Description                                                                                                  |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `dataDir` | `string` | PGlite data directory, e.g. `idb://my-app` in the browser or a path in Node. Omit for an in-memory database. |

## `openPGliteEngine(options?)`

```ts
function openPGliteEngine(options?: OpenPGliteEngineOptions): Promise<PGliteEngine>;
```

Takes `PGliteEngineOptions` plus `pglite?: PGliteOptions` (extensions, debug, ...; set it in the worker, since it may not be plain data).

Returns a `PGliteEngine`: a `DBEngine` with `database`, the `PGlite` instance.

Behaviour:

- A `run` statement **without parameters** runs with `exec`, so it may contain several statements.
- `affectedRows` is reported for `all` / `get` queries.

With Vite, add `optimizeDeps: { exclude: ["@electric-sql/pglite"] }` to `vite.config.ts`.

## Types

`PGliteDBStorageOptions`, `PGliteEngineOptions` (both entry points), `OpenPGliteEngineOptions`, `PGliteEngine` (`/worker`).
