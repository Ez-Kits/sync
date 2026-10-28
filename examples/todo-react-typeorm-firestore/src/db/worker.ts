import { startDBStorageWorker } from "@ez-kits/sync-client-core";
import { openSqlJsEngine, type SqlJsEngineOptions } from "@ez-kits/sync-storage-sqljs/worker";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { migrateLocalSchema } from "./migrations.ts";

/**
 * Every tab runs this worker; only the elected leader's worker opens sql.js (from the
 * IndexedDB snapshot), so snapshots from different tabs cannot clobber each other.
 */
startDBStorageWorker<SqlJsEngineOptions>(async (options) => {
  const engine = await openSqlJsEngine({ ...options, wasmUrl });
  try {
    await migrateLocalSchema(engine);
  } catch (error) {
    await engine.close();
    throw error;
  }
  return engine;
});
