import type { CollectionConfigMap, DBExecutor } from "@ez-kits/sync-client-core";
import type { AnyRelations } from "drizzle-orm";
// Deep import: the driver entry point would pull in sql.js.
import { sqlJsCodecs } from "drizzle-orm/sql-js/codecs";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type DrizzleSQLiteConfig,
} from "drizzle-orm/sqlite-core";
import {
  drizzle,
  type SqliteProxyExecutors,
  type SqliteRemoteDatabase,
} from "drizzle-orm/sqlite-proxy";
import type { BuildRelationsFromCollections, BuildSchemaFromCollections } from "../collection";
import { createDrizzleLocalChangeStore } from "../create-drizzle-local-change-store";
import {
  createDrizzleProxyDBAdapter,
  type DrizzleProxyDBAdapterConfig,
} from "../create-drizzle-proxy-db-adapter";
import { initializeLocalChangeSchema, type LocalChangeSchemaScripts } from "../local-change-schema";
import type { DrizzleDBAdapter } from "../types";

// Columns are named explicitly so a `casing` option cannot rename them.

/**
 * Outbox, dirty-record and applied-event tables of SQLite storages, created by the adapter
 * itself. `seq` is assigned on insert, so pending events follow commit order.
 */
export const sqliteLocalChangeTables = {
  events: sqliteTable(
    "ez_sync_events",
    {
      seq: integer("seq").primaryKey({ autoIncrement: true }),
      id: text("id").notNull().unique(),
      type: text("type").notNull(),
      collection: text("collection").notNull(),
      data: text("data", { mode: "json" }),
      recordId: text("recordId").notNull(),
      createdAt: integer("createdAt").notNull(),
    },
    (table) => [
      index("ez_sync_events_collection_seq").on(table.collection, table.seq),
      index("ez_sync_events_record").on(table.collection, table.recordId),
    ],
  ),
  dirtyRecords: sqliteTable(
    "ez_sync_dirty_records",
    {
      collection: text("collection").notNull(),
      recordId: text("recordId").notNull(),
      state: text("state").notNull(),
      updatedAt: integer("updatedAt").notNull(),
    },
    (table) => [uniqueIndex("ez_sync_dirty_record_key").on(table.collection, table.recordId)],
  ),
  appliedEvents: sqliteTable(
    "ez_sync_applied_events",
    {
      eventId: text("eventId").primaryKey(),
      appliedAt: integer("appliedAt").notNull(),
    },
    (table) => [index("ez_sync_applied_events_applied_at").on(table.appliedAt)],
  ),
};

const SQLITE_EVENTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS ez_sync_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  collection TEXT NOT NULL,
  data TEXT,
  recordId TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);`;

/** Creates and upgrades {@link sqliteLocalChangeTables}; run by the store's `initialize`. */
const SQLITE_LOCAL_CHANGE_SCHEMA: LocalChangeSchemaScripts = {
  createMeta:
    "CREATE TABLE IF NOT EXISTS ez_sync_meta (key TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL)",
  hasEvents: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ez_sync_events'",
  create: `${SQLITE_EVENTS_TABLE_DDL}
CREATE INDEX IF NOT EXISTS ez_sync_events_collection_seq ON ez_sync_events (collection, seq);
CREATE INDEX IF NOT EXISTS ez_sync_events_record ON ez_sync_events (collection, recordId);
CREATE TABLE IF NOT EXISTS ez_sync_dirty_records (
  collection TEXT NOT NULL,
  recordId TEXT NOT NULL,
  state TEXT NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ez_sync_dirty_record_key
  ON ez_sync_dirty_records (collection, recordId);
CREATE TABLE IF NOT EXISTS ez_sync_applied_events (
  eventId TEXT PRIMARY KEY NOT NULL,
  appliedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ez_sync_applied_events_applied_at
  ON ez_sync_applied_events (appliedAt);
`,
  upgradeFromV1: `
CREATE TEMP TABLE ez_sync_events_v1 AS SELECT * FROM ez_sync_events;
DROP TABLE ez_sync_events;
${SQLITE_EVENTS_TABLE_DDL}
INSERT INTO ez_sync_events (seq, id, type, collection, data, recordId, createdAt)
  SELECT row_number() OVER (ORDER BY createdAt, id), id, type, collection, data, recordId, createdAt
  FROM temp.ez_sync_events_v1;
DROP TABLE temp.ez_sync_events_v1;
`,
};

/** Drizzle options of SQLite adapters. `codecs` default to Drizzle's sql.js codecs. */
export type DrizzleSqliteOptions<TRelations extends AnyRelations> = Omit<
  DrizzleSQLiteConfig<TRelations>,
  "relations"
>;

export type DrizzleSqliteDBAdapterConfig<
  C extends CollectionConfigMap,
  TRelations extends AnyRelations = BuildRelationsFromCollections<C>,
> = DrizzleProxyDBAdapterConfig<C, TRelations, DrizzleSqliteOptions<TRelations>>;

/** `drizzle-orm/sqlite-proxy` executors that run every statement on a DB storage. */
export function sqliteProxyExecutors(executor: DBExecutor): SqliteProxyExecutors {
  return {
    all: (async (sql: string, params: unknown[], rowMode?: "array" | "object") =>
      (await executor.exec({ sql, params, method: "all", rowMode }))
        .rows) as SqliteProxyExecutors["all"],
    get: (async (sql: string, params: unknown[], rowMode?: "array" | "object") =>
      (await executor.exec({ sql, params, method: "get", rowMode }))
        .rows[0]) as SqliteProxyExecutors["get"],
    run: async (sql: string, params: unknown[]) => {
      await executor.exec({ sql, params, method: "run" });
    },
  };
}

/**
 * A Drizzle adapter for SQLite storages (sql.js, SQLite WASM), through
 * `drizzle-orm/sqlite-proxy`. The outbox lives in {@link sqliteLocalChangeTables}.
 */
export function createDrizzleSqliteDBAdapter<
  C extends CollectionConfigMap,
  TRelations extends AnyRelations = BuildRelationsFromCollections<C>,
>(
  config: DrizzleSqliteDBAdapterConfig<C, TRelations>,
): DrizzleDBAdapter<C, SqliteRemoteDatabase<unknown, TRelations>, BuildSchemaFromCollections<C>> {
  const drizzleConfig = config.drizzleConfig ?? {};
  return createDrizzleProxyDBAdapter(config, {
    dialect: "sqlite",
    createDatabase: (executor, relations: TRelations) =>
      drizzle(sqliteProxyExecutors(executor), {
        ...drizzleConfig,
        relations,
        codecs: drizzleConfig.codecs ?? sqlJsCodecs,
      }),
    createLocalChangeStore: (db, dbStorage) =>
      createDrizzleLocalChangeStore({
        db,
        tables: sqliteLocalChangeTables,
        initialize: () => initializeLocalChangeSchema(dbStorage, SQLITE_LOCAL_CHANGE_SCHEMA),
      }),
  });
}
