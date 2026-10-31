import type { WorkerDBStorageOptions } from "@ez-kits/sync-client-core";

/** Structured-cloneable engine options, sent from the page to the storage worker. */
export interface SqlJsEngineOptions {
  /** URL of `sql-wasm.wasm`; bundlers can provide it with an `?url` import. */
  wasmUrl?: string;
  /** IndexedDB database holding the snapshot. Omit for an in-memory database. */
  indexedDBName?: string;
}

export type SqlJsDBStorageOptions = Omit<WorkerDBStorageOptions<SqlJsEngineOptions>, "dialect">;
