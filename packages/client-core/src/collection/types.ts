import type { SyncAdapter } from "../sync-handler";

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
  syncAdapter?: SyncAdapter<
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

/**
 * The collections of a client. Any array works: an inline `[todos, users]`, a tuple, or a
 * `const collections = [todos, users]` (typed `(Todos | Users)[]`) stored first.
 */
export type CollectionConfigMap<TCheckpoint = any> = readonly CollectionConfig<
  any,
  any,
  any,
  any,
  any,
  any,
  TCheckpoint
>[];

/** Union of `name` fields for all collections in the map. */
export type CollectionNames<C extends CollectionConfigMap> = C[number]["name"];

/** Config entry whose `name` is `N`. */
export type ConfigForName<C extends CollectionConfigMap, N extends CollectionNames<C>> = Extract<
  C[number],
  { name: N }
>;

export interface TCollectionRuntime<C extends CollectionConfig<any, any, any, any, any, any>> {
  /** Create a record; rejects with the database's constraint error if its primary key exists. */
  insert: (data: InferCollectionInsertModel<C>) => Promise<void>;
  update: (data: InferCollectionUpdateModel<C>) => Promise<void>;
  /**
   * Insert the record if its primary key is missing, else update the row with its fields, in
   * one transaction. The outbox records what happened: a `create` or an `update`.
   */
  upsert: (data: InferCollectionInsertModel<C>) => Promise<void>;
  delete: (id: InferCollectionPrimaryFieldType<C>) => Promise<void>;
  /**
   * The `*Many` writes apply every record in one transaction (all or none), with one outbox
   * event per record, in order, and refresh live queries once. An empty list does nothing.
   */
  insertMany: (data: readonly InferCollectionInsertModel<C>[]) => Promise<void>;
  updateMany: (data: readonly InferCollectionUpdateModel<C>[]) => Promise<void>;
  upsertMany: (data: readonly InferCollectionInsertModel<C>[]) => Promise<void>;
  deleteMany: (ids: readonly InferCollectionPrimaryFieldType<C>[]) => Promise<void>;
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
