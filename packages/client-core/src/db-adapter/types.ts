import type {
  CollectionConfigMap,
  CollectionNames,
  ConfigForName,
  InferCollectionInsertModel,
  InferCollectionPrimaryFieldType,
  InferCollectionSelectModel,
  InferCollectionUpdateModel,
} from "../collection";

export interface BaseDBAdapter<
  C extends CollectionConfigMap,
  TQueryBuilder,
  TQuerySchema extends Record<CollectionNames<C>, unknown>,
> {
  queryBuilder: TQueryBuilder;
  querySchema: TQuerySchema;
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
