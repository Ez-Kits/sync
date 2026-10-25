import { drizzle } from "drizzle-orm/sqlite-proxy";
import { SqlJsWorkerClient, type RowMode } from "./sqljs-worker-client.ts";

export const sqlJsWorker = new SqlJsWorkerClient();

export const db = drizzle({
  all: async (sql: string, params: unknown[], rowMode?: RowMode) =>
    (await sqlJsWorker.exec(sql, params, "all", rowMode)).rows as any[],
  get: async (sql: string, params: unknown[], rowMode?: RowMode) =>
    (await sqlJsWorker.exec(sql, params, "get", rowMode)).rows as any,
  run: async (sql: string, params: unknown[]) => {
    await sqlJsWorker.exec(sql, params, "run");
  },
});

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

  await sqlJsWorker.exec(
    `CREATE TABLE IF NOT EXISTS ez_sync_events (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      collection TEXT NOT NULL,
      data TEXT,
      recordId TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )`,
    [],
    "run",
  );
  await sqlJsWorker.exec(
    `CREATE TABLE IF NOT EXISTS ez_sync_dirty_records (
      collection TEXT NOT NULL,
      recordId TEXT NOT NULL,
      state TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      UNIQUE (collection, recordId)
    )`,
    [],
    "run",
  );

  const tableInfo = await sqlJsWorker.exec("PRAGMA table_info(todos)", [], "all");
  const columns = tableInfo.rows as unknown[][];
  if (!columns.some((column) => column[1] === "deleted")) {
    await sqlJsWorker.exec(
      `ALTER TABLE todos ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`,
      [],
      "run",
    );
  }
}
