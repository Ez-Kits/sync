import {
  createAtomicLocalMutationStorage,
  type CollectionConfigMap,
  type CollectionNames,
} from "@ez-kits/sync-client-core";
import type {
  DrizzleDirtyRecordTable,
  DrizzleEventTable,
  DrizzleLocalChangeStoreTables,
  DrizzleSchemaTypeCheck,
} from "./create-drizzle-local-change-store";
import { createDrizzleLocalChangeStore } from "./create-drizzle-local-change-store";
import { createDrizzleDBAdapter, type DrizzleDBAdapterConfig } from "./create-drizzle-db-adapter";
import type { BuildSchemaFromCollections } from "./collection";

export type DrizzleStorageConfig<
  C extends CollectionConfigMap,
  TDrizzleDB,
  TTables extends Record<CollectionNames<C>, unknown> = BuildSchemaFromCollections<C>,
  TEvents extends DrizzleEventTable = DrizzleEventTable,
  TDirtyRecords extends DrizzleDirtyRecordTable = DrizzleDirtyRecordTable,
> = DrizzleDBAdapterConfig<C, TDrizzleDB, TTables> & {
  localChangeTables: DrizzleLocalChangeStoreTables<TEvents, TDirtyRecords>;
};

export function createDrizzleStorage<
  C extends CollectionConfigMap,
  TDrizzleDB,
  TTables extends Record<CollectionNames<C>, unknown> = BuildSchemaFromCollections<C>,
  TEvents extends DrizzleEventTable = DrizzleEventTable,
  TDirtyRecords extends DrizzleDirtyRecordTable = DrizzleDirtyRecordTable,
>(
  config: DrizzleStorageConfig<C, TDrizzleDB, TTables, TEvents, TDirtyRecords>,
  ...typeCheck: DrizzleSchemaTypeCheck<TEvents, TDirtyRecords>
) {
  void typeCheck;
  return createAtomicLocalMutationStorage(
    config.db,
    (db) =>
      createDrizzleDBAdapter({
        db,
        collections: config.collections,
        schema: config.schema,
      }),
    (db) =>
      createDrizzleLocalChangeStore(
        {
          db,
          tables: config.localChangeTables,
        },
        ...typeCheck,
      ),
  );
}
