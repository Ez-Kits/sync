# @ez-kits/sync-storage-sqljs

A `DBStorage` for EzSync backed by [sql.js](https://sql.js.org): SQLite compiled to WASM, kept in memory inside a dedicated worker and snapshotted to IndexedDB.

Every tab starts its own worker. The workers elect a leader with Web Locks; only the leader opens sql.js, and the other tabs forward their statements and transactions to it. When the leader tab closes, another worker takes over and reopens the last snapshot.

```ts
// src/db/worker.ts
import { startDBStorageWorker } from "@ez-kits/sync-client-core";
import { openSqlJsEngine } from "@ez-kits/sync-storage-sqljs/worker";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";

startDBStorageWorker(async (options) => {
  const engine = await openSqlJsEngine({ ...options, wasmUrl });
  await engine.exec({ sql: "CREATE TABLE IF NOT EXISTS todos (...)", params: [], method: "run" });
  return engine;
});
```

```ts
// src/db/index.ts
import { createSqlJsStorage } from "@ez-kits/sync-storage-sqljs";

export const dbStorage = createSqlJsStorage({
  key: "todos",
  engineOptions: { indexedDB: "todos-sqljs" },
  worker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
});
```

Pass `dbStorage` to a DB adapter, for example `createDrizzleSqliteDBAdapter({ dbStorage, collections })` from `@ez-kits/sync-client-drizzle-adapter/sqlite`.

The snapshot is rewritten after every commit and every write outside a transaction. Statements run without parameters may contain several statements, which keeps migrations simple.
