import { createWorkerDBStorage, type DBStorage } from "@ez-kits/sync-client-core";
import type { PGliteStorageOptions } from "./options";

export type * from "./options";

/**
 * Postgres (PGlite) storage shared by every tab. The database lives in the leader tab's
 * worker, which must call `startDBStorageWorker` with `openPGliteEngine` from
 * `@ez-kits/sync-storage-pglite/worker`.
 */
export function createPGliteStorage(options: PGliteStorageOptions): DBStorage {
  return createWorkerDBStorage({ ...options, dialect: "postgres" });
}
