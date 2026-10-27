import type { DBExecutor } from "@ez-kits/sync-client-core";

const run = (sql: string) => ({ sql, params: [], method: "run" as const });

/**
 * Create or upgrade the app's tables. Runs in the leader's storage worker on open; the sync
 * client creates its own outbox tables.
 */
export async function migrateLocalSchema(db: DBExecutor): Promise<void> {
  await db.exec(
    run(`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL,
        dirty INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0
      );
    `),
  );

  const tableInfo = await db.exec({ sql: "PRAGMA table_info(todos)", params: [], method: "all" });
  const columns = tableInfo.rows as unknown[][];
  if (!columns.some((column) => column[1] === "deleted")) {
    await db.exec(run("ALTER TABLE todos ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0"));
  }
}
