import type { SyncOptions } from "../sync-handler";

export interface CollectionConfig<
  TCollectionName extends string,
  AdapterConfig,
  _UpdateModel,
  _InsertModel,
  _SelectModel,
  PrimaryField extends keyof _SelectModel,
  TCheckpoint = unknown,
> {
  name: TCollectionName;
  adapterConfig: AdapterConfig;
  primaryField: PrimaryField;
  sync?: SyncOptions<
    Record<
      TCollectionName,
      {
        create: _InsertModel;
        update: _UpdateModel;
        delete: _SelectModel[PrimaryField];
      }
    >,
    TCollectionName,
    TCheckpoint
  >;
}

export type CollectionConfigMap<TCheckpoint = any> = [
  CollectionConfig<any, any, any, any, any, any, TCheckpoint>,
  ...CollectionConfig<any, any, any, any, any, any, TCheckpoint>[],
];

/** Union of `name` fields for all collections in the map. */
export type CollectionNames<C extends CollectionConfigMap> = C[number]["name"];

/** Config entry whose `name` is `N`. */
export type ConfigForName<C extends CollectionConfigMap, N extends CollectionNames<C>> = Extract<
  C[number],
  { name: N }
>;

export interface TCollectionRuntime<C extends CollectionConfig<any, any, any, any, any, any>> {
  insert: (data: InferCollectionInsertModel<C>) => Promise<void>;
  update: (data: InferCollectionUpdateModel<C>) => Promise<void>;
  delete: (id: InferCollectionPrimaryFieldType<C>) => Promise<void>;
  get: (id: InferCollectionPrimaryFieldType<C>) => Promise<InferCollectionSelectModel<C>>;
  getMany: () => Promise<InferCollectionSelectModel<C>[]>;
}

export type TCollectionRuntimeRecord<C extends CollectionConfigMap> = {
  [K in CollectionNames<C>]: TCollectionRuntime<ConfigForName<C, K>>;
};

export type InferCollectionUpdateModel<C extends CollectionConfig<any, any, any, any, any, any>> =
  C extends CollectionConfig<any, any, infer UpdateModel, any, any, any, any> ? UpdateModel : never;

export type InferCollectionInsertModel<C extends CollectionConfig<any, any, any, any, any, any>> =
  C extends CollectionConfig<any, any, any, infer InsertModel, any, any, any> ? InsertModel : never;

export type InferCollectionSelectModel<C extends CollectionConfig<any, any, any, any, any, any>> =
  C extends CollectionConfig<any, any, any, any, infer SelectModel, any, any> ? SelectModel : never;

export type InferCollectionPrimaryFieldType<
  C extends CollectionConfig<any, any, any, any, any, any>,
> =
  C extends CollectionConfig<any, any, any, any, infer SelectModel, infer PrimaryField, any>
    ? SelectModel[PrimaryField]
    : never;

/** Checkpoint type on a single collection config. */
export type InferCollectionCheckpoint<C extends CollectionConfig<any, any, any, any, any, any>> =
  C extends CollectionConfig<any, any, any, any, any, any, infer TCP> ? TCP : unknown;

/** Union of checkpoint types across all collections. */
export type InferCheckpointMap<C extends CollectionConfigMap> = InferCollectionCheckpoint<
  C[number]
>;
