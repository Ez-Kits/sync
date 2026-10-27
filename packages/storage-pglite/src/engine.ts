import type { DBEngine, DBQuery, DBQueryResult } from "@ez-kits/sync-client-core";
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import type { PGliteEngineOptions } from "./options";

export interface OpenPGliteEngineOptions extends PGliteEngineOptions {
  /** Extra PGlite options (extensions, debug, ...). */
  pglite?: PGliteOptions;
}

export interface PGliteEngine extends DBEngine {
  /** The underlying PGlite instance, for migrations or tooling. */
  readonly database: PGlite;
}

async function execute(pg: PGlite, query: DBQuery): Promise<DBQueryResult> {
  // Without parameters every statement runs, so migrations can be one script.
  if (query.method === "run" && query.params.length === 0) {
    await pg.exec(query.sql);
    return { rows: [] };
  }
  const result = await pg.query(query.sql, query.params, { rowMode: query.rowMode ?? "array" });
  if (query.method === "run") return { rows: [] };
  return { rows: query.method === "get" ? result.rows.slice(0, 1) : result.rows };
}

/** Open PGlite in this (leader) worker. PGlite persists `idb://` data on its own. */
export async function openPGliteEngine(
  options: OpenPGliteEngineOptions = {},
): Promise<PGliteEngine> {
  const pg = await PGlite.create(options.dataDir, options.pglite);
  return {
    database: pg,
    exec: (query) => execute(pg, query),
    close: () => pg.close(),
  };
}
