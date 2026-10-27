import type { WorkerDBStorageOptions } from "@ez-kits/sync-client-core";

/** Structured-cloneable engine options, sent from the page to the storage worker. */
export interface SqliteWasmEngineOptions {
  /** Database file name inside the pool, e.g. `/todos.sqlite3`. */
  filename: string;
  /**
   * `opfs-sahpool` (default) persists to the Origin Private File System without
   * COOP/COEP headers; only one worker may hold it, which suits a leader-only engine.
   * `memory` keeps the database in memory.
   */
  vfs?: "opfs-sahpool" | "memory";
  /** Name of the OPFS pool. Defaults to `ez-sync`. */
  poolName?: string;
}

export type SqliteWasmStorageOptions = Omit<
  WorkerDBStorageOptions<SqliteWasmEngineOptions>,
  "dialect"
>;
