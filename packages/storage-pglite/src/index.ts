import { createWorkerDBStorage, type DBStorage } from "@ez-kits/sync-client-core";
import type { PGliteDBStorageOptions } from "./options";

export type * from "./options";

/**
 * Postgres (PGlite) storage shared by every tab. The database lives in the leader tab's
 * worker, which must call `startDBStorageWorker` with `openPGliteEngine` from
 * `@ez-kits/sync-storage-pglite/worker`.
 */
export function createPGliteDBStorage(options: PGliteDBStorageOptions): DBStorage {
  return createWorkerDBStorage({ ...options, dialect: "postgres" });
}
