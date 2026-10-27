import {
  createCoordinatedStorage,
  type AtomicLocalChangeStore,
  type CollectionConfigMap,
  type CollectionNames,
  type CoordinatedStorage,
  type ExclusiveStorageOptions,
  type SharedStorageOptions,
} from "@ez-kits/sync-client-core";
import type { BuildSchemaFromCollections } from "./collection";
import { createDrizzleDBAdapter } from "./create-drizzle-db-adapter";
import type {
  DrizzleDirtyRecordTable,
  DrizzleEventTable,
  DrizzleLocalChangeStoreTables,
  DrizzleSchemaTypeCheck,
} from "./create-drizzle-local-change-store";
import { createDrizzleLocalChangeStore } from "./create-drizzle-local-change-store";
import type { DrizzleDBAdapter } from "./types";

type StorageAdapter<
  C extends CollectionConfigMap,
  TDrizzleDB,
  TTables extends Record<CollectionNames<C>, unknown>,
> = DrizzleDBAdapter<C, TDrizzleDB, TTables>;

/** Coordination options shared by both sharing modes; factories are supplied by the adapter. */
type CoordinationOptions<TOptions> = Omit<TOptions, "createDBAdapter" | "createLocalChangeStore">;

export type DrizzleStorageConfig<
  C extends CollectionConfigMap,
  TDrizzleDB,
  TTables extends Record<CollectionNames<C>, unknown> = BuildSchemaFromCollections<C>,
  TEvents extends DrizzleEventTable = DrizzleEventTable,
  TDirtyRecords extends DrizzleDirtyRecordTable = DrizzleDirtyRecordTable,
  TRequest = unknown,
  TResponse = unknown,
> = {
  readonly collections: C;
  readonly schema?: TTables;
  localChangeTables: DrizzleLocalChangeStoreTables<TEvents, TDirtyRecords>;
} & (
  | CoordinationOptions<
      ExclusiveStorageOptions<
        TDrizzleDB,
        StorageAdapter<C, TDrizzleDB, TTables>,
        AtomicLocalChangeStore,
        TRequest,
        TResponse
      >
    >
  | CoordinationOptions<
      SharedStorageOptions<
        TDrizzleDB,
        StorageAdapter<C, TDrizzleDB, TTables>,
        AtomicLocalChangeStore
      >
    >
);

/**
 * Coordinated storage for a Drizzle database. With the default `exclusive` sharing only
 * the elected tab opens the database; other tabs reach it through `connect`
 * (see {@link forwardSqliteProxy}). Use `sharing: "shared"` for engines already shared
 * across tabs.
 */
export function createDrizzleStorage<
  C extends CollectionConfigMap,
  TDrizzleDB,
  TTables extends Record<CollectionNames<C>, unknown> = BuildSchemaFromCollections<C>,
  TEvents extends DrizzleEventTable = DrizzleEventTable,
  TDirtyRecords extends DrizzleDirtyRecordTable = DrizzleDirtyRecordTable,
  TRequest = unknown,
  TResponse = unknown,
>(
  config: DrizzleStorageConfig<C, TDrizzleDB, TTables, TEvents, TDirtyRecords, TRequest, TResponse>,
  ...typeCheck: DrizzleSchemaTypeCheck<TEvents, TDirtyRecords>
): CoordinatedStorage<StorageAdapter<C, TDrizzleDB, TTables>, AtomicLocalChangeStore> {
  const { collections, schema, localChangeTables, ...coordination } = config;
  return createCoordinatedStorage({
    ...coordination,
    createDBAdapter: (db: TDrizzleDB) =>
      createDrizzleDBAdapter<C, TDrizzleDB, TTables>({ db, collections, schema }),
    createLocalChangeStore: (db: TDrizzleDB) =>
      createDrizzleLocalChangeStore<TDrizzleDB, TEvents, TDirtyRecords>(
        { db, tables: localChangeTables },
        ...typeCheck,
      ),
  } as ExclusiveStorageOptions<
    TDrizzleDB,
    StorageAdapter<C, TDrizzleDB, TTables>,
    AtomicLocalChangeStore,
    TRequest,
    TResponse
  >);
}
