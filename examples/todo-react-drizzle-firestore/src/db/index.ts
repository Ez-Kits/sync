import type { OwnedDatabase } from "@ez-kits/sync-client-core";
import {
  executeSqliteProxyRequest,
  forwardSqliteProxy,
  type SqliteProxyRequest,
} from "@ez-kits/sync-client-drizzle-adapter";
import {
  drizzle,
  type SqliteProxyExecutors,
  type SqliteRemoteDatabase,
} from "drizzle-orm/sqlite-proxy";
import { SqlJsWorkerClient } from "./sqljs-worker-client.ts";

export type LocalDatabase = SqliteRemoteDatabase;

function workerExecutors(worker: SqlJsWorkerClient): SqliteProxyExecutors {
  return {
    all: (async (sql: string, params: unknown[], rowMode?: "array" | "object") =>
      (await worker.exec(sql, params, "all", rowMode)).rows) as SqliteProxyExecutors["all"],
    get: (async (sql: string, params: unknown[], rowMode?: "array" | "object") =>
      (await worker.exec(sql, params, "get", rowMode)).rows) as SqliteProxyExecutors["get"],
    run: async (sql: string, params: unknown[]) => {
      await worker.exec(sql, params, "run");
    },
  };
}

/**
 * Runs only in the tab that owns local storage: starts the sql.js worker from the
 * IndexedDB snapshot. Other tabs never start a worker, so snapshots cannot clobber
 * each other.
 */
export async function openLocalDatabase(): Promise<
  OwnedDatabase<LocalDatabase, SqliteProxyRequest, unknown>
> {
  const worker = new SqlJsWorkerClient();
  const executors = workerExecutors(worker);
  try {
    await migrateLocalSchema(worker);
  } catch (error) {
    worker.close();
    throw error;
  }
  return {
    database: drizzle(executors),
    execute: (request) => executeSqliteProxyRequest(executors, request),
    // Every commit already awaits its snapshot, so ownership can end at any time.
    close: async () => worker.close(),
  };
}

/** Follower tabs: a Drizzle database whose statements run in the owner tab. */
export function connectLocalDatabase(
  send: (request: SqliteProxyRequest) => Promise<unknown>,
): LocalDatabase {
  return drizzle(forwardSqliteProxy(send));
}

async function migrateLocalSchema(worker: SqlJsWorkerClient): Promise<void> {
  await worker.exec(
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

  await worker.exec(
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
  await worker.exec(
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

  const tableInfo = await worker.exec("PRAGMA table_info(todos)", [], "all");
  const columns = tableInfo.rows as unknown[][];
  if (!columns.some((column) => column[1] === "deleted")) {
    await worker.exec(`ALTER TABLE todos ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`, [], "run");
  }
}
