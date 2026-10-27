import type {
  BaseDBAdapter,
  CollectionConfigMap,
  CollectionNames,
  DBStorage,
  DirtyRecord,
  StoredChangeBusEvent,
} from "@ez-kits/sync-client-core";
import type { BuildSchemaFromCollections, EntityClass } from "./collection";
import type { DataSource } from "typeorm";

export type TypeOrmQueryResult<Q> = Q extends Promise<infer R> ? R : Q;

export interface TypeOrmDBAdapter<
  C extends CollectionConfigMap,
  TDataSource,
  TSchema extends Record<CollectionNames<C>, unknown>,
> extends BaseDBAdapter<C, TDataSource, TSchema> {
  readonly db: TDataSource;
  readonly schema: TSchema;
}

export type TypeOrmDBAdapterConfig<
  C extends CollectionConfigMap,
  TDataSource extends DataSource = DataSource,
  TSchema extends Record<CollectionNames<C>, unknown> = BuildSchemaFromCollections<C>,
  TEventEntity extends EntityClass<StoredChangeBusEvent> = EntityClass<StoredChangeBusEvent>,
  TDirtyEntity extends EntityClass<DirtyRecord> = EntityClass<DirtyRecord>,
> = {
  readonly db: TDataSource;
  readonly schema?: TSchema;
  readonly collections: C;
  /** Outbox and dirty-record entities, in the same data source as the collections. */
  readonly eventEntity: TEventEntity;
  readonly dirtyRecordEntity: TDirtyEntity;
  /**
   * The storage reported to the sync client. Defaults to one that runs on the data
   * source in this context, which always leads: TypeORM cannot forward to another tab.
   */
  readonly dbStorage?: DBStorage;
};
