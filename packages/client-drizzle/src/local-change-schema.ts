import type { DBExecutor, DBStorage } from "@ez-kits/sync-client-core";

/**
 * Version of the outbox tables the store reads and writes. 5 added the `ez_sync_revisions`
 * table; 6 dropped `ez_sync_dirty_records`.
 */
const LOCAL_CHANGE_SCHEMA_VERSION = 6;

/** One dialect's scripts for {@link initializeLocalChangeSchema}; none takes parameters. */
export interface LocalChangeSchemaScripts {
  /** Create `ez_sync_meta (key, value)` when missing. */
  readonly createMeta: string;
  /**
   * Create the current tables and indexes when missing. Every statement is `IF NOT EXISTS`, so
   * it also adds the tables a later version introduced.
   */
  readonly create: string;
}

const run = (sql: string) => ({ sql, params: [], method: "run" as const });

async function readVersion(tx: DBExecutor): Promise<number> {
  const { rows } = await tx.exec({
    sql: "SELECT value FROM ez_sync_meta WHERE key = 'schema_version'",
    params: [],
    method: "all",
  });
  return Number((rows[0] as unknown[] | undefined)?.[0] ?? 0);
}

/**
 * Create the outbox tables in one storage transaction. Transactions run one at a
 * time on the leader, so contexts initializing together see each other's result and the
 * later ones change nothing.
 */
export function initializeLocalChangeSchema(
  dbStorage: DBStorage,
  scripts: LocalChangeSchemaScripts,
): Promise<void> {
  return dbStorage.transaction(async (tx) => {
    await tx.exec(run(scripts.createMeta));
    if ((await readVersion(tx)) >= LOCAL_CHANGE_SCHEMA_VERSION) return;
    await tx.exec(run(scripts.create));
    await tx.exec(
      run(
        `INSERT INTO ez_sync_meta (key, value) VALUES ('schema_version', ${LOCAL_CHANGE_SCHEMA_VERSION})
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      ),
    );
  });
}
