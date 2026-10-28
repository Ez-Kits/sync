import type { CollectionConfigMap, DirtyRecord } from "@ez-kits/sync-client-core";
import { DataSource, EntitySchema, type DataSourceOptions } from "typeorm";
import type { BuildSchemaFromCollections } from "../collection";
import {
  createTypeOrmProxyDBAdapter,
  type TypeOrmProxyDBAdapterConfig,
} from "../core/create-typeorm-proxy-db-adapter";
import type { TypeOrmEventRow } from "../core/local-change-store";
import type { TypeOrmDBAdapter } from "../types";
import { createTypeOrmSqliteDriver } from "./storage-driver";

export * from "./storage-driver";

/**
 * Outbox and dirty-record entities of SQLite storages. The adapter registers them and
 * creates and upgrades their tables itself; applications never declare or migrate them.
 * `seq` is assigned on insert, so pending events follow commit order.
 */
export const sqliteLocalChangeEntities = {
  events: new EntitySchema<TypeOrmEventRow>({
    name: "EzSyncEvent",
    tableName: "ez_sync_events",
    columns: {
      seq: { type: "integer", primary: true, generated: "increment" },
      id: { type: "text", unique: true },
      type: { type: "text" },
      collection: { type: "text" },
      data: { type: "simple-json", nullable: true },
      recordId: { type: "text" },
      createdAt: { type: "integer" },
    },
    indices: [
      { name: "ez_sync_events_collection_seq", columns: ["collection", "seq"] },
      { name: "ez_sync_events_record", columns: ["collection", "recordId"] },
    ],
  }),
  dirtyRecords: new EntitySchema<DirtyRecord>({
    name: "EzSyncDirtyRecord",
    tableName: "ez_sync_dirty_records",
    columns: {
      collection: { type: "text", primary: true },
      recordId: { type: "text", primary: true },
      state: { type: "text" },
      updatedAt: { type: "integer" },
    },
  }),
};

/** Data source options of SQLite adapters; the type, driver and entities are set for you. */
export type TypeOrmSqliteDataSourceOptions = Omit<
  Extract<DataSourceOptions, { type: "expo" }>,
  "type" | "database" | "driver" | "entities"
>;

export type TypeOrmSqliteDBAdapterConfig<C extends CollectionConfigMap> =
  TypeOrmProxyDBAdapterConfig<C, TypeOrmSqliteDataSourceOptions>;

/**
 * A TypeORM adapter for SQLite storages (sql.js, SQLite WASM). It creates an `expo` data
 * source whose driver runs every statement on the storage
 * ({@link createTypeOrmSqliteDriver}), and keeps the outbox in
 * {@link sqliteLocalChangeEntities}.
 */
export function createTypeOrmSqliteDBAdapter<C extends CollectionConfigMap>(
  config: TypeOrmSqliteDBAdapterConfig<C>,
): TypeOrmDBAdapter<C, BuildSchemaFromCollections<C>> {
  return createTypeOrmProxyDBAdapter(config, {
    dialect: "sqlite",
    createDataSource: (dbStorage, entities, dataSourceOptions) =>
      new DataSource({
        ...dataSourceOptions,
        type: "expo",
        database: dbStorage.key,
        driver: createTypeOrmSqliteDriver(dbStorage),
        entities,
      }),
    localChangeEntities: sqliteLocalChangeEntities,
  });
}
