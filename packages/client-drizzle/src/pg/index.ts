import type { CollectionConfigMap } from "@ez-kits/sync-client-core";
import type { AnyRelations } from "drizzle-orm";
import {
  bigint,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  type DrizzlePgConfig,
} from "drizzle-orm/pg-core";
import { drizzle, type PgRemoteDatabase } from "drizzle-orm/pg-proxy";
// Deep import: the driver entry point would pull in PGlite.
import { pgliteCodecs } from "drizzle-orm/pglite/codecs";
import type { BuildRelationsFromCollections, BuildSchemaFromCollections } from "../collection";
import { createDrizzleLocalChangeStore } from "../create-drizzle-local-change-store";
import {
  createDrizzleProxyDBAdapter,
  type DrizzleProxyDBAdapterConfig,
} from "../create-drizzle-proxy-db-adapter";
import type { DrizzleDBAdapter } from "../types";

// Columns are named explicitly so a `casing` option cannot rename them.

/** Outbox and dirty-record tables of Postgres storages, created by the adapter itself. */
export const pgLocalChangeTables = {
  events: pgTable("ez_sync_events", {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    collection: text("collection").notNull(),
    data: jsonb("data"),
    recordId: text("recordId").notNull(),
    createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  }),
  dirtyRecords: pgTable(
    "ez_sync_dirty_records",
    {
      collection: text("collection").notNull(),
      recordId: text("recordId").notNull(),
      state: text("state").notNull(),
      updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
    },
    (table) => [uniqueIndex("ez_sync_dirty_record_key").on(table.collection, table.recordId)],
  ),
};

/** Creates {@link pgLocalChangeTables}; run by the local-change store's `initialize`. */
const PG_LOCAL_CHANGE_TABLES_DDL = `
CREATE TABLE IF NOT EXISTS ez_sync_events (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  collection TEXT NOT NULL,
  data JSONB,
  "recordId" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS ez_sync_dirty_records (
  collection TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  state TEXT NOT NULL,
  "updatedAt" BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ez_sync_dirty_record_key
  ON ez_sync_dirty_records (collection, "recordId");
`;

/** Drizzle options of Postgres adapters. `codecs` default to Drizzle's PGlite codecs. */
export type DrizzlePgOptions<TRelations extends AnyRelations> = Omit<
  DrizzlePgConfig<TRelations>,
  "relations"
>;

export type DrizzlePgDBAdapterConfig<
  C extends CollectionConfigMap,
  TRelations extends AnyRelations = BuildRelationsFromCollections<C>,
> = DrizzleProxyDBAdapterConfig<C, TRelations, DrizzlePgOptions<TRelations>>;

/**
 * A Drizzle adapter for Postgres storages (PGlite), through `drizzle-orm/pg-proxy`. The
 * outbox lives in {@link pgLocalChangeTables}.
 */
export function createDrizzlePgDBAdapter<
  C extends CollectionConfigMap,
  TRelations extends AnyRelations = BuildRelationsFromCollections<C>,
>(
  config: DrizzlePgDBAdapterConfig<C, TRelations>,
): DrizzleDBAdapter<C, PgRemoteDatabase<TRelations>, BuildSchemaFromCollections<C>> {
  const drizzleConfig = config.drizzleConfig ?? {};
  return createDrizzleProxyDBAdapter(config, {
    dialect: "postgres",
    createDatabase: (executor, relations: TRelations) =>
      drizzle(
        async (sql, params, method) =>
          executor.exec({
            sql,
            params,
            method: "all",
            rowMode: method === "all" ? "array" : "object",
          }),
        { ...drizzleConfig, relations, codecs: drizzleConfig.codecs ?? pgliteCodecs },
      ),
    createLocalChangeStore: (db, dbStorage) =>
      createDrizzleLocalChangeStore({
        db,
        tables: pgLocalChangeTables,
        initialize: async () => {
          await dbStorage.exec({ sql: PG_LOCAL_CHANGE_TABLES_DDL, params: [], method: "run" });
        },
      }),
  });
}
