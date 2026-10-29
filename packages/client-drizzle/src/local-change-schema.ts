import type { DBExecutor, DBStorage } from "@ez-kits/sync-client-core";

/**
 * Version of the outbox tables the store reads and writes; 2 added the `seq` column, 3 the
 * `ez_sync_applied_events` table.
 */
export const LOCAL_CHANGE_SCHEMA_VERSION = 3;

/** One dialect's scripts for {@link initializeLocalChangeSchema}; none takes parameters. */
export interface LocalChangeSchemaScripts {
  /** Create `ez_sync_meta (key, value)` when missing. */
  readonly createMeta: string;
  /** Return a row when `ez_sync_events` exists. */
  readonly hasEvents: string;
  /**
   * Create the current tables and indexes when missing. Every statement is `IF NOT EXISTS`,
   * so it also adds the tables a later version introduced (version 2 to 3).
   */
  readonly create: string;
  /** Rebuild a version 1 `ez_sync_events` (no `seq`), in `createdAt, id` order. */
  readonly upgradeFromV1: string;
}

const run = (sql: string) => ({ sql, params: [], method: "run" as const });

async function readVersion(tx: DBExecutor, scripts: LocalChangeSchemaScripts): Promise<number> {
  const { rows } = await tx.exec({
    sql: "SELECT value FROM ez_sync_meta WHERE key = 'schema_version'",
    params: [],
    method: "all",
  });
  const stored = (rows[0] as unknown[] | undefined)?.[0];
  if (stored !== undefined) return Number(stored);
  // Version 1 kept no meta table; its events table is the only trace of it.
  const events = await tx.exec({ sql: scripts.hasEvents, params: [], method: "all" });
  return events.rows.length > 0 ? 1 : 0;
}

/**
 * Create or upgrade the outbox tables in one storage transaction. Transactions run one at a
 * time on the leader, so contexts initializing together see each other's result and the
 * later ones change nothing.
 */
export function initializeLocalChangeSchema(
  dbStorage: DBStorage,
  scripts: LocalChangeSchemaScripts,
): Promise<void> {
  return dbStorage.transaction(async (tx) => {
    await tx.exec(run(scripts.createMeta));
    const version = await readVersion(tx, scripts);
    if (version >= LOCAL_CHANGE_SCHEMA_VERSION) return;
    if (version === 1) await tx.exec(run(scripts.upgradeFromV1));
    await tx.exec(run(scripts.create));
    await tx.exec(
      run(
        `INSERT INTO ez_sync_meta (key, value) VALUES ('schema_version', ${LOCAL_CHANGE_SCHEMA_VERSION})
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      ),
    );
  });
}
