import { createWorkerDBStorage, type DBStorage } from "@ez-kits/sync-client-core";
import type { WaSqliteDBStorageOptions } from "./options";

export type * from "./options";

/**
 * wa-sqlite storage shared by every tab. The database lives in the leader tab's worker,
 * which must call `startDBStorageWorker` with `openWaSqliteEngine` from
 * `@ez-kits/sync-client-storage-wa-sqlite/worker`.
 */
export function createWaSqliteDBStorage(options: WaSqliteDBStorageOptions): DBStorage {
  return createWorkerDBStorage({ ...options, dialect: "sqlite" });
}
