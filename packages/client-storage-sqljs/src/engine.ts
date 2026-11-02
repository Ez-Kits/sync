import type { DBEngine, DBQuery, DBQueryResult } from "@ez-kits/sync-client-core";
import initSqlJs, {
  type Database,
  type SqlJsConfig,
  type SqlJsStatic,
  type SqlValue,
} from "sql.js";
import type { SqlJsEngineOptions } from "./options";
import { deleteSnapshot, loadSnapshot, saveSnapshot, type SnapshotLocation } from "./snapshot";

export interface OpenSqlJsEngineOptions extends SqlJsEngineOptions {
  /** A loaded sql.js module, e.g. a custom build. Defaults to `initSqlJs()`. */
  sqlJs?: SqlJsStatic | Promise<SqlJsStatic>;
  /** Defaults to `globalThis.indexedDB`. */
  indexedDBFactory?: IDBFactory;
}

export interface SqlJsEngine extends DBEngine {
  /** The underlying sql.js database, for migrations or tooling. */
  readonly database: Database;
}

/** sql.js init options: load the wasm binary from `wasmUrl` when given. */
export function sqlJsConfig(wasmUrl: string | undefined): SqlJsConfig | undefined {
  return wasmUrl === undefined ? undefined : { locateFile: () => wasmUrl };
}

function toSqlValue(value: unknown): SqlValue {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return Number(value);
  return value as SqlValue;
}

function execute(db: Database, query: DBQuery): DBQueryResult {
  const params = query.params.map(toSqlValue);
  if (query.method === "run") {
    // Without parameters every statement runs, so migrations can be one script.
    if (params.length === 0) db.run(query.sql);
    else db.run(query.sql, params);
    return { rows: [] };
  }
  const statement = db.prepare(query.sql, params);
  try {
    const rows: unknown[] = [];
    while (statement.step()) {
      rows.push(query.rowMode === "object" ? statement.getAsObject() : statement.get());
      if (query.method === "get") break;
    }
    return { rows };
  } finally {
    statement.free();
  }
}

function snapshotLocation(options: OpenSqlJsEngineOptions): SnapshotLocation | undefined {
  return options.indexedDBName === undefined
    ? undefined
    : { name: options.indexedDBName, factory: options.indexedDBFactory ?? indexedDB };
}

/**
 * Open sql.js in this (leader) worker, restoring the IndexedDB snapshot. The storage
 * flushes after every commit and every write outside a transaction, which saves a new
 * snapshot; sql.js's `export()` would abort an open transaction, so it never runs inside one.
 */
export async function openSqlJsEngine(options: OpenSqlJsEngineOptions = {}): Promise<SqlJsEngine> {
  const SQL = await (options.sqlJs ?? initSqlJs(sqlJsConfig(options.wasmUrl)));
  const location = snapshotLocation(options);
  const snapshot = location ? await loadSnapshot(location) : null;
  const db = new SQL.Database(snapshot ? new Uint8Array(snapshot) : undefined);
  return {
    database: db,
    exec: async (query) => execute(db, query),
    flush: async () => {
      if (location) await saveSnapshot(location, db.export());
    },
    close: async () => db.close(),
  };
}

/**
 * Delete the database `openSqlJsEngine` opens with these options: its IndexedDB snapshot.
 * Pass it as `destroy` to `startDBStorageWorker` to enable `DBStorage.destroy`.
 */
export async function destroySqlJsDatabase(options: OpenSqlJsEngineOptions = {}): Promise<void> {
  const location = snapshotLocation(options);
  if (location) await deleteSnapshot(location);
}
