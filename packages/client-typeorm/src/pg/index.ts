import type { CollectionConfigMap, DirtyRecord } from "@ez-kits/sync-client-core";
import { DataSource, EntitySchema, type DataSourceOptions, type ValueTransformer } from "typeorm";
import type { BuildSchemaFromCollections } from "../collection";
import {
  createTypeOrmProxyDBAdapter,
  type TypeOrmProxyDBAdapterConfig,
} from "../core/create-typeorm-proxy-db-adapter";
import type { TypeOrmEventRow } from "../core/local-change-store";
import type { TypeOrmDBAdapter } from "../types";
import { createTypeOrmPgDriver } from "./storage-driver";

export * from "./storage-driver";

/** Millisecond timestamps exceed `integer`; read `bigint` columns back as numbers. */
const bigintAsNumber: ValueTransformer = {
  to: (value: unknown) => value,
  from: (value: unknown) => (value === null ? value : Number(value)),
};

/**
 * Outbox and dirty-record entities of Postgres storages. The adapter registers them and
 * creates and upgrades their tables itself; applications never declare or migrate them.
 * `seq` is assigned on insert, so pending events follow commit order.
 */
export const pgLocalChangeEntities = {
  events: new EntitySchema<TypeOrmEventRow>({
    name: "EzSyncEvent",
    tableName: "ez_sync_events",
    columns: {
      seq: { type: "bigint", primary: true, generated: "increment", transformer: bigintAsNumber },
      id: { type: "text", unique: true },
      type: { type: "text" },
      collection: { type: "text" },
      data: { type: "jsonb", nullable: true },
      recordId: { type: "text" },
      createdAt: { type: "bigint", transformer: bigintAsNumber },
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
      updatedAt: { type: "bigint", transformer: bigintAsNumber },
    },
  }),
};

/** Data source options of Postgres adapters; the type, driver and entities are set for you. */
export type TypeOrmPgDataSourceOptions = Omit<
  Extract<DataSourceOptions, { type: "postgres" }>,
  "type" | "driver" | "entities"
>;

export type TypeOrmPgDBAdapterConfig<C extends CollectionConfigMap> = TypeOrmProxyDBAdapterConfig<
  C,
  TypeOrmPgDataSourceOptions
>;

/**
 * A TypeORM adapter for Postgres storages (PGlite). It creates a `postgres` data source
 * whose `pg` module runs every statement on the storage ({@link createTypeOrmPgDriver}),
 * and keeps the outbox in {@link pgLocalChangeEntities}.
 */
export function createTypeOrmPgDBAdapter<C extends CollectionConfigMap>(
  config: TypeOrmPgDBAdapterConfig<C>,
): TypeOrmDBAdapter<C, BuildSchemaFromCollections<C>> {
  return createTypeOrmProxyDBAdapter(config, {
    dialect: "postgres",
    createDataSource: (dbStorage, entities, dataSourceOptions) =>
      new DataSource({
        // Storage engines run their own extensions; PGlite cannot create TypeORM's.
        installExtensions: false,
        ...dataSourceOptions,
        type: "postgres",
        driver: createTypeOrmPgDriver(dbStorage),
        entities,
      }),
    localChangeEntities: pgLocalChangeEntities,
  });
}
