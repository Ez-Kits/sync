import { createWorkerDBStorage, type DBStorage } from "@ez-kits/sync-client-core";
import type { SqlJsDBStorageOptions } from "./options";

export type * from "./options";

/**
 * SQLite (sql.js) storage shared by every tab. The database lives in the leader tab's
 * worker, which must call `startDBStorageWorker` with `openSqlJsEngine` from
 * `@ez-kits/sync-client-storage-sqljs/worker`.
 */
export function createSqlJsDBStorage(options: SqlJsDBStorageOptions): DBStorage {
  return createWorkerDBStorage({ ...options, dialect: "sqlite" });
}
