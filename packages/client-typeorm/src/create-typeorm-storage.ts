import type {
  AtomicLocalChangeStore,
  DirtyRecord,
  StoredChangeBusEvent,
} from "@ez-kits/sync-client-core";
import {
  createCoordinatedStorage,
  type CollectionConfigMap,
  type CollectionNames,
  type CoordinatedStorage,
  type SharedStorageOptions,
} from "@ez-kits/sync-client-core";
import type { DataSource } from "typeorm";
import type { BuildSchemaFromCollections, EntityClass } from "./collection";
import { createTypeOrmDBAdapter } from "./create-typeorm-db-adapter";
import type { TypeOrmSchemaTypeCheck } from "./create-typeorm-local-change-store";
import { createTypeOrmLocalChangeStore } from "./create-typeorm-local-change-store";
import type { TypeOrmDBAdapter } from "./types";

/**
 * TypeORM storage is opened by every context (`sharing: "shared"`): use a data source
 * whose engine is shared across tabs, or `coordinateTabs: false` for a single context.
 * TypeORM has no query proxy, so single-owner (`exclusive`) storage is not available.
 */
export type TypeOrmStorageConfig<
  C extends CollectionConfigMap,
  TDataSource extends DataSource,
  TSchema extends Record<CollectionNames<C>, unknown> = BuildSchemaFromCollections<C>,
  TEventEntity extends EntityClass<StoredChangeBusEvent> = EntityClass<StoredChangeBusEvent>,
  TDirtyEntity extends EntityClass<DirtyRecord> = EntityClass<DirtyRecord>,
> = Omit<
  SharedStorageOptions<
    TDataSource,
    TypeOrmDBAdapter<C, TDataSource, TSchema>,
    AtomicLocalChangeStore
  >,
  "sharing" | "createDBAdapter" | "createLocalChangeStore"
> & {
  readonly collections: C;
  readonly schema?: TSchema;
  eventEntity: TEventEntity;
  dirtyRecordEntity: TDirtyEntity;
};

export function createTypeOrmStorage<
  C extends CollectionConfigMap,
  TDataSource extends DataSource = DataSource,
  TSchema extends Record<CollectionNames<C>, unknown> = BuildSchemaFromCollections<C>,
  TEventEntity extends EntityClass<StoredChangeBusEvent> = EntityClass<StoredChangeBusEvent>,
  TDirtyEntity extends EntityClass<DirtyRecord> = EntityClass<DirtyRecord>,
>(
  config: TypeOrmStorageConfig<C, TDataSource, TSchema, TEventEntity, TDirtyEntity>,
  ...typeCheck: TypeOrmSchemaTypeCheck<TEventEntity, TDirtyEntity>
): CoordinatedStorage<TypeOrmDBAdapter<C, TDataSource, TSchema>, AtomicLocalChangeStore> {
  const { collections, schema, eventEntity, dirtyRecordEntity, ...coordination } = config;
  return createCoordinatedStorage({
    ...coordination,
    sharing: "shared",
    createDBAdapter: (db: TDataSource) =>
      createTypeOrmDBAdapter<C, TDataSource, TSchema>({ db, collections, schema }),
    createLocalChangeStore: (db: TDataSource) =>
      createTypeOrmLocalChangeStore({ db, eventEntity, dirtyRecordEntity }, ...typeCheck),
  });
}
