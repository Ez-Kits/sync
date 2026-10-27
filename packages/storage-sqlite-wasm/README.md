# @ez-kits/sync-storage-sqlite-wasm

A `DBStorage` for EzSync backed by the official [SQLite WASM](https://sqlite.org/wasm) build, running in a dedicated worker and persisted to the Origin Private File System through the `opfs-sahpool` VFS (no COOP/COEP headers needed).

Every tab starts its own worker. The workers elect a leader with Web Locks; only the leader opens the pool (the VFS allows a single holder per origin), and the other tabs forward their statements and transactions to it. The leader releases the pool when it steps down, so the next leader can open it.

```ts
// src/db/worker.ts
import { startDBStorageWorker } from "@ez-kits/sync-client-core";
import { openSqliteWasmEngine } from "@ez-kits/sync-storage-sqlite-wasm/worker";

startDBStorageWorker(async (options) => {
  const engine = await openSqliteWasmEngine(options);
  await engine.exec({ sql: "CREATE TABLE IF NOT EXISTS todos (...)", params: [], method: "run" });
  return engine;
});
```

```ts
// src/db/index.ts
import { createSqliteWasmStorage } from "@ez-kits/sync-storage-sqlite-wasm";

export const dbStorage = createSqliteWasmStorage({
  key: "todos",
  engineOptions: { filename: "/todos.sqlite3" },
  worker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
});
```

Use it with `createDrizzleSqliteDBAdapter({ dbStorage, collections })` from `@ez-kits/sync-client-drizzle-adapter/sqlite`.
