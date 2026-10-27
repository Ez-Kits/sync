# @ez-kits/sync-storage-pglite

A Postgres `DBStorage` for EzSync backed by [PGlite](https://pglite.dev), running in a dedicated worker and persisted to IndexedDB (`idb://...`).

Every tab starts its own worker. The workers elect a leader with Web Locks; only the leader opens PGlite, and the other tabs forward their statements and transactions to it.

```ts
// src/db/worker.ts
import { startDBStorageWorker } from "@ez-kits/sync-client-core";
import { openPGliteEngine } from "@ez-kits/sync-storage-pglite/worker";

startDBStorageWorker(async (options) => {
  const engine = await openPGliteEngine(options);
  await engine.exec({ sql: "CREATE TABLE IF NOT EXISTS todos (...)", params: [], method: "run" });
  return engine;
});
```

```ts
// src/db/index.ts
import { createPGliteStorage } from "@ez-kits/sync-storage-pglite";

export const dbStorage = createPGliteStorage({
  key: "todos",
  engineOptions: { dataDir: "idb://todos" },
  worker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
});
```

Use it with `createDrizzlePgDBAdapter({ dbStorage, collections })` from `@ez-kits/sync-client-drizzle-adapter/pg`.
