import type {
  BaseDBAdapter,
  CollectionConfigMap,
  CollectionNames,
} from "@ez-kits/sync-client-core";
import type { BuildSchemaFromCollections } from "./collection";
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
> = {
  readonly db: TDataSource;
  readonly schema?: TSchema;
  readonly collections: C;
};
