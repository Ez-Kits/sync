import type {
  CollectionConfigMap,
  CollectionNames,
  ConfigForName,
  InferCollectionInsertModel,
  InferCollectionPrimaryFieldType,
  InferCollectionSelectModel,
  InferCollectionUpdateModel,
} from "../collection";

/**
 * CRUD operations available both on the adapter and inside {@link BaseDBAdapter.transaction}.
 */
export interface DBAdapterOperations<C extends CollectionConfigMap> {
  insert<N extends CollectionNames<C>>(
    collection: N,
    data: InferCollectionInsertModel<ConfigForName<C, N>>,
  ): Promise<void>;
  update<N extends CollectionNames<C>>(
    collection: N,
    data: InferCollectionUpdateModel<ConfigForName<C, N>>,
  ): Promise<void>;
  delete<N extends CollectionNames<C>>(
    collection: N,
    id: InferCollectionPrimaryFieldType<ConfigForName<C, N>>,
  ): Promise<void>;
  get<N extends CollectionNames<C>>(
    collection: N,
    id: InferCollectionPrimaryFieldType<ConfigForName<C, N>>,
  ): Promise<InferCollectionSelectModel<ConfigForName<C, N>>>;
  getMany<N extends CollectionNames<C>>(
    collection: N,
  ): Promise<InferCollectionSelectModel<ConfigForName<C, N>>[]>;
}

export interface BaseDBAdapter<
  C extends CollectionConfigMap,
  TQueryBuilder,
  TQuerySchema extends Record<CollectionNames<C>, unknown>,
> extends DBAdapterOperations<C> {
  queryBuilder: TQueryBuilder;
  querySchema: TQuerySchema;
  /**
   * Run adapter operations in a single database transaction.
   * All writes succeed together or none are applied.
   */
  transaction<T>(fn: (tx: DBAdapterOperations<C>) => Promise<T>): Promise<T>;
}
