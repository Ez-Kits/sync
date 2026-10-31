import { createWorkerDBStorage, type DBStorage } from "@ez-kits/sync-client-core";
import type { SqliteWasmDBStorageOptions } from "./options";

export type * from "./options";

/**
 * SQLite WASM storage shared by every tab. The database lives in the leader tab's
 * worker, which must call `startDBStorageWorker` with `openSqliteWasmEngine` from
 * `@ez-kits/sync-client-storage-sqlite-wasm/worker`.
 */
export function createSqliteWasmDBStorage(options: SqliteWasmDBStorageOptions): DBStorage {
  return createWorkerDBStorage({ ...options, dialect: "sqlite" });
}
