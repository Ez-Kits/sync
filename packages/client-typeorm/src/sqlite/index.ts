import type {
  CollectionConfigMap,
  DirtyRecord,
  StoredChangeBusEvent,
} from "@ez-kits/sync-client-core";
import { DataSource, EntitySchema, type DataSourceOptions } from "typeorm";
import type { BuildSchemaFromCollections } from "../collection";
import {
  createTypeOrmProxyDBAdapter,
  type TypeOrmProxyDBAdapterConfig,
} from "../core/create-typeorm-proxy-db-adapter";
import type { TypeOrmDBAdapter } from "../types";
import { createTypeOrmSqliteDriver } from "./storage-driver";

export * from "./storage-driver";

/**
 * Outbox and dirty-record entities of SQLite storages. The adapter registers them and
 * creates their tables itself; applications never declare or migrate them.
 */
export const sqliteLocalChangeEntities = {
  events: new EntitySchema<StoredChangeBusEvent>({
    name: "EzSyncEvent",
    tableName: "ez_sync_events",
    columns: {
      id: { type: "text", primary: true },
      type: { type: "text" },
      collection: { type: "text" },
      data: { type: "simple-json", nullable: true },
      recordId: { type: "text" },
      createdAt: { type: "integer" },
    },
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
