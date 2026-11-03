import type { WorkerDBStorageOptions } from "@ez-kits/sync-client-core";

/** Structured-cloneable engine options, sent from the page to the storage worker. */
export interface WaSqliteEngineOptions {
  /**
   * Database file name, e.g. `todos.sqlite3`. With `opfs` it is the path inside the Origin
   * Private File System; with `indexeddb` it also names the IndexedDB database.
   */
  filename: string;
  /**
   * Where the database is saved:
   * - `opfs` (default): the Origin Private File System, with `OPFSCoopSyncVFS`. Fast and
   *   incremental; needs a dedicated worker, which the storage worker is.
   * - `indexeddb`: IndexedDB, with `IDBBatchAtomicVFS`. Works where OPFS is missing.
   * - `memory`: in memory, lost when the leader closes it.
   */
  vfs?: "opfs" | "indexeddb" | "memory";
}

export type WaSqliteDBStorageOptions = Omit<
  WorkerDBStorageOptions<WaSqliteEngineOptions>,
  "dialect"
>;
