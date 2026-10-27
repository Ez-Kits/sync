import { createWorkerDBStorage, type DBStorage } from "@ez-kits/sync-client-core";
import type { SqlJsStorageOptions } from "./options";

export type * from "./options";

/**
 * SQLite (sql.js) storage shared by every tab. The database lives in the leader tab's
 * worker, which must call `startDBStorageWorker` with `openSqlJsEngine` from
 * `@ez-kits/sync-storage-sqljs/worker`.
 */
export function createSqlJsStorage(options: SqlJsStorageOptions): DBStorage {
  return createWorkerDBStorage({ ...options, dialect: "sqlite" });
}
