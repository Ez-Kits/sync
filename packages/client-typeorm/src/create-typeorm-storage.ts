import {
  createAtomicLocalMutationStorage,
  type CollectionConfigMap,
  type CollectionNames,
} from "@ez-kits/sync-client-core";
import type { DataSource } from "typeorm";
import type { EntityClass, BuildSchemaFromCollections } from "./collection";
import { createTypeOrmDBAdapter } from "./create-typeorm-db-adapter";
import { createTypeOrmLocalChangeStore } from "./create-typeorm-local-change-store";
import type { TypeOrmSchemaTypeCheck } from "./create-typeorm-local-change-store";
import type { DirtyRecord, StoredChangeBusEvent } from "@ez-kits/sync-client-core";
import type { TypeOrmDBAdapterConfig } from "./types";

export type TypeOrmStorageConfig<
  C extends CollectionConfigMap,
  TDataSource extends DataSource,
  TSchema extends Record<CollectionNames<C>, unknown> = BuildSchemaFromCollections<C>,
  TEventEntity extends EntityClass<StoredChangeBusEvent> = EntityClass<StoredChangeBusEvent>,
  TDirtyEntity extends EntityClass<DirtyRecord> = EntityClass<DirtyRecord>,
> = TypeOrmDBAdapterConfig<C, TDataSource, TSchema> & {
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
) {
  void typeCheck;
  return createAtomicLocalMutationStorage(
    config.db,
    (db) =>
      createTypeOrmDBAdapter({
        db,
        collections: config.collections,
        schema: config.schema,
      }),
    (db) =>
      createTypeOrmLocalChangeStore(
        {
          db,
          eventEntity: config.eventEntity,
          dirtyRecordEntity: config.dirtyRecordEntity,
        },
        ...typeCheck,
      ),
  );
}
