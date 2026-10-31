import type { DBEngine, DBQuery, DBQueryResult } from "@ez-kits/sync-client-core";
import sqlite3InitModule, {
  type BindableValue,
  type Database,
  type SAHPoolUtil,
  type Sqlite3Static,
} from "@sqlite.org/sqlite-wasm";
import type { SqliteWasmEngineOptions } from "./options";

export interface OpenSqliteWasmEngineOptions extends SqliteWasmEngineOptions {
  /** A loaded SQLite module. Defaults to the package's own build. */
  sqlite3?: Sqlite3Static | Promise<Sqlite3Static>;
}

export interface SqliteWasmEngine extends DBEngine {
  /** The underlying SQLite database, for migrations or tooling. */
  readonly database: Database;
}

function toBindable(value: unknown): BindableValue {
  return value === undefined ? null : (value as BindableValue);
}

function execute(db: Database, query: DBQuery): DBQueryResult {
  const bind = query.params.length > 0 ? query.params.map(toBindable) : undefined;
  if (query.method === "run") {
    db.exec({ sql: query.sql, bind });
    return { rows: [] };
  }
  const rows: unknown[] =
    query.rowMode === "object"
      ? db.selectObjects(query.sql, bind)
      : db.selectArrays(query.sql, bind);
  return { rows: query.method === "get" ? rows.slice(0, 1) : rows };
}

async function openPool(sqlite3: Sqlite3Static, name: string): Promise<SAHPoolUtil> {
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name });
  // A worker that led before paused the pool when it stepped down.
  return pool.isPaused() ? pool.unpauseVfs() : pool;
}

/**
 * Open SQLite in this (leader) worker. With the default `opfs-sahpool` VFS the file
 * handles are released on close, so the next leader's worker can open the pool.
 */
export async function openSqliteWasmEngine(
  options: OpenSqliteWasmEngineOptions,
): Promise<SqliteWasmEngine> {
  const sqlite3 = await (options.sqlite3 ?? sqlite3InitModule());
  const pool =
    options.vfs === "memory" ? undefined : await openPool(sqlite3, options.poolName ?? "ez-sync");
  const db = pool ? new pool.OpfsSAHPoolDb(options.filename) : new sqlite3.oo1.DB(":memory:");
  return {
    database: db,
    exec: async (query) => execute(db, query),
    close: async () => {
      db.close();
      pool?.pauseVfs();
    },
  };
}
