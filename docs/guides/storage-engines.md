# Choosing a storage engine

The storage engine is the real database in the browser. EzSync ships four. All of them run in a Web Worker, share one database across tabs, and keep data between visits.

## At a glance

|                         | sql.js                               | SQLite WASM                                | wa-sqlite                                    | PGlite                                |
| ----------------------- | ------------------------------------ | ------------------------------------------ | -------------------------------------------- | ------------------------------------- |
| Package                 | `@ez-kits/sync-client-storage-sqljs` | `@ez-kits/sync-client-storage-sqlite-wasm` | `@ez-kits/sync-client-storage-wa-sqlite`     | `@ez-kits/sync-client-storage-pglite` |
| SQL dialect             | SQLite                               | SQLite                                     | SQLite                                       | Postgres                              |
| Saved to                | IndexedDB (whole-file snapshot)      | OPFS (incremental writes)                  | OPFS or IndexedDB, you choose (incremental)  | IndexedDB                             |
| Cost of a write         | Grows with database size             | Small                                      | Small                                        | Small                                 |
| Needs COOP/COEP headers | No                                   | No                                         | No                                           | No                                    |
| Download size           | Small                                | Medium                                     | Medium                                       | Large                                 |
| Good for                | Getting started, small data          | Most production apps on SQLite             | SQLite apps that need IndexedDB, or a choice | Postgres features and types           |

**How to choose:**

- **Start with sql.js.** It is the easiest to set up.
- **Move to SQLite WASM** when your database grows past a few megabytes or you write often. sql.js saves the **whole** database after every commit; SQLite WASM writes only what changed. Your Drizzle/TypeORM code stays the same (both are SQLite).
- **Pick wa-sqlite** to choose between OPFS and IndexedDB, for example IndexedDB for browsers or contexts without OPFS, or to save the database as a plain OPFS file you can export.
- **Pick PGlite** if you want Postgres: `JSONB`, arrays, richer types, or the same dialect as your server. It is the largest download.

Every engine follows the same two-file pattern:

1. a **worker file** that calls `startDBStorageWorker` with the engine's `open...Engine` function (and its `destroy...Database` function, so you can [delete the database](syncing.md#deleting-the-local-database)), and
2. a `create...Storage` call on the page that starts that worker.

The `key` option names the database: every tab with the same key shares it. `engineOptions` are sent to the worker, so they must be plain data (strings, numbers, objects).

## sql.js

```ts
// db/worker.ts
import { startDBStorageWorker } from "@ez-kits/sync-client-core";
import {
  destroySqlJsDatabase,
  openSqlJsEngine,
  type SqlJsEngineOptions,
} from "@ez-kits/sync-client-storage-sqljs/worker";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { migrate } from "./migrations";

startDBStorageWorker<SqlJsEngineOptions>({
  open: async (options) => {
    const engine = await openSqlJsEngine({ ...options, wasmUrl });
    await migrate(engine);
    return engine;
  },
  destroy: destroySqlJsDatabase,
});
```

```ts
// db/storage.ts
import { createSqlJsDBStorage } from "@ez-kits/sync-client-storage-sqljs";

export const dbStorage = createSqlJsDBStorage({
  key: "my-app",
  engineOptions: { indexedDBName: "my-app-db" }, // leave out for an in-memory database
  worker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
});
```

Use it with `createDrizzleSqliteDBAdapter` or `createTypeOrmSqliteDBAdapter`.

**Notes**

- sql.js needs its `.wasm` file. With Vite, `import wasmUrl from "sql.js/dist/sql-wasm.wasm?url"` gives you its URL. Other bundlers have similar "asset URL" imports; you can also host the file and pass its URL.
- The database is in memory and saved to IndexedDB after every commit. A new leader reopens the last saved copy.
- In migrations, a `run` statement **without parameters** may contain several statements separated by `;`.

## SQLite WASM

The official SQLite build, saved to the Origin Private File System (OPFS) with the `opfs-sahpool` driver. It needs **no** special HTTP headers.

```ts
// db/worker.ts
import { startDBStorageWorker } from "@ez-kits/sync-client-core";
import {
  destroySqliteWasmDatabase,
  openSqliteWasmEngine,
  type SqliteWasmEngineOptions,
} from "@ez-kits/sync-client-storage-sqlite-wasm/worker";
import { migrate } from "./migrations";

startDBStorageWorker<SqliteWasmEngineOptions>({
  open: async (options) => {
    const engine = await openSqliteWasmEngine(options);
    await migrate(engine);
    return engine;
  },
  destroy: destroySqliteWasmDatabase,
});
```

```ts
// db/storage.ts
import { createSqliteWasmDBStorage } from "@ez-kits/sync-client-storage-sqlite-wasm";

export const dbStorage = createSqliteWasmDBStorage({
  key: "my-app",
  engineOptions: {
    filename: "/my-app.sqlite3", // the file inside the OPFS pool (required)
    // vfs: "memory",            // keep it in memory instead (tests, demos)
    // poolName: "ez-sync",      // the OPFS pool name (default "ez-sync")
  },
  worker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
});
```

Use it with `createDrizzleSqliteDBAdapter` or `createTypeOrmSqliteDBAdapter`.

**Notes**

- With Vite, exclude the package from dependency pre-bundling so its `.wasm` file is found:

  ```ts
  // vite.config.ts
  export default defineConfig({
    optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  });
  ```

- The OPFS pool allows **one** holder per origin. EzSync opens it only in the leader and releases it when the leader steps down, so this works across tabs. Two different apps on the **same origin** should use different `poolName`s.

## wa-sqlite

[wa-sqlite](https://github.com/powersync-ja/wa-sqlite), saved to OPFS (`OPFSCoopSyncVFS`) or IndexedDB (`IDBBatchAtomicVFS`). Both write only the pages that changed, and neither needs special HTTP headers.

```ts
// db/worker.ts
import { startDBStorageWorker } from "@ez-kits/sync-client-core";
import {
  destroyWaSqliteDatabase,
  openWaSqliteEngine,
  type WaSqliteEngineOptions,
} from "@ez-kits/sync-client-storage-wa-sqlite/worker";
import { migrate } from "./migrations";

startDBStorageWorker<WaSqliteEngineOptions>({
  open: async (options) => {
    const engine = await openWaSqliteEngine(options);
    await migrate(engine);
    return engine;
  },
  destroy: destroyWaSqliteDatabase,
});
```

```ts
// db/storage.ts
import { createWaSqliteDBStorage } from "@ez-kits/sync-client-storage-wa-sqlite";

export const dbStorage = createWaSqliteDBStorage({
  key: "my-app",
  engineOptions: {
    filename: "my-app.sqlite3", // the OPFS file, or the IndexedDB database name (required)
    vfs: "opfs", // "opfs" (default), "indexeddb" or "memory"
  },
  worker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
});
```

Use it with `createDrizzleSqliteDBAdapter` or `createTypeOrmSqliteDBAdapter`.

**OPFS or IndexedDB?**

- `opfs` is faster, and the database is a plain file in OPFS. It needs synchronous OPFS access handles, which every current browser offers in a dedicated worker, and the storage worker is one.
- `indexeddb` works wherever IndexedDB does. It uses the slower asynchronous wa-sqlite build.
- The two do not share data: switching `vfs` starts from an empty database.

**Notes**

- With Vite, exclude the package from dependency pre-bundling so its `.wasm` files are found:

  ```ts
  // vite.config.ts
  export default defineConfig({
    optimizeDeps: { exclude: ["@journeyapps/wa-sqlite"] },
  });
  ```

- Two different apps on the **same origin** should use different `filename`s.

## PGlite

Postgres compiled to WebAssembly.

```ts
// db/worker.ts
import { startDBStorageWorker } from "@ez-kits/sync-client-core";
import {
  destroyPGliteDatabase,
  openPGliteEngine,
  type PGliteEngineOptions,
} from "@ez-kits/sync-client-storage-pglite/worker";
import { migrate } from "./migrations";

startDBStorageWorker<PGliteEngineOptions>({
  open: async (options) => {
    const engine = await openPGliteEngine(options);
    await migrate(engine);
    return engine;
  },
  destroy: destroyPGliteDatabase,
});
```

```ts
// db/storage.ts
import { createPGliteDBStorage } from "@ez-kits/sync-client-storage-pglite";

export const dbStorage = createPGliteDBStorage({
  key: "my-app",
  engineOptions: { dataDir: "idb://my-app" }, // leave out for an in-memory database
  worker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
});
```

Use it with `createDrizzlePgDBAdapter` or `createTypeOrmPgDBAdapter`, and define your tables with `pgTable` (Drizzle) or Postgres column types (TypeORM).

**Notes**

- With Vite, exclude PGlite from pre-bundling: `optimizeDeps: { exclude: ["@electric-sql/pglite"] }`.
- PGlite extensions and other options can be passed in the worker: `openPGliteEngine({ ...options, pglite: { extensions: { ... } } })`. Options that are not plain data (like extensions) must be set in the worker, not in `engineOptions`.

## Storage options shared by every engine

`createSqlJsDBStorage`, `createSqliteWasmDBStorage`, `createWaSqliteDBStorage` and `createPGliteDBStorage` take the same options:

| Option                 | Default     | Meaning                                                                                                                                                             |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker`               | required    | A function that starts the storage worker: `() => new Worker(url, { type: "module" })`.                                                                             |
| `key`                  | `"default"` | The database name for tab coordination. Tabs with the same key share one database.                                                                                  |
| `engineOptions`        | `undefined` | Plain data sent to the worker's `open` function.                                                                                                                    |
| `requestTimeoutMs`     | `10000`     | How long a follower waits for the leader before checking it is still alive, and how long the database may take to open before `LeaderUnavailableError` is reported. |
| `transactionTimeoutMs` | `10000`     | An open transaction idle longer than this is rolled back, so one stuck tab cannot block all.                                                                        |

## Using an engine without a worker

In Node.js, tests, or a single-page context where you do not need multi-tab sharing, run the engine directly with `createLocalDBStorage`. See [Node.js and tests](node-and-tests.md).

## Another engine?

You can plug in any database that can run SQL. See [Custom DB storage](../extending/custom-db-storage.md).
