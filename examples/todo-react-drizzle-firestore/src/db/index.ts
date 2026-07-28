import { drizzle } from "drizzle-orm/sqlite-proxy";
import { schema } from "./schema.ts";
import { SqlJsWorkerClient } from "./sqljs-worker-client.ts";

export const sqlJsWorker = new SqlJsWorkerClient();

export const db = drizzle(
  async (sql, params, method) => {
    const result = await sqlJsWorker.exec(sql, params, method);
    return { rows: result.rows as unknown[] };
  },
  { schema },
);

export async function migrateLocalSchema(): Promise<void> {
  await sqlJsWorker.exec(
    `CREATE TABLE IF NOT EXISTS todos (
			id TEXT PRIMARY KEY NOT NULL,
			title TEXT NOT NULL,
			completed INTEGER NOT NULL DEFAULT 0,
			updatedAt INTEGER NOT NULL,
			dirty INTEGER NOT NULL DEFAULT 0,
			deleted INTEGER NOT NULL DEFAULT 0
		)`,
    [],
    "run",
  );

  try {
    await sqlJsWorker.exec(
      `ALTER TABLE todos ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`,
      [],
      "run",
    );
  } catch {
    // Column already exists on fresh / previously migrated DBs.
  }
}
