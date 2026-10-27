import type { WorkerDBStorageOptions } from "@ez-kits/sync-client-core";

/** Structured-cloneable engine options, sent from the page to the storage worker. */
export interface PGliteEngineOptions {
  /** PGlite data directory, e.g. `idb://todos`. Omit for an in-memory database. */
  dataDir?: string;
}

export type PGliteStorageOptions = Omit<WorkerDBStorageOptions<PGliteEngineOptions>, "dialect">;
