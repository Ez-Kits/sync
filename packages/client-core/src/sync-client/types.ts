import type {
  ChangeBusEvent,
  ChangeBusEventDataMap,
  ChangeBusEventDataMapFromCollectionConfigMap,
  ChangeBusSubscribeOptions,
} from "../change-bus";
import type { ICheckpointStorage } from "../checkpoint-storage";
import type {
  CollectionConfigMap,
  CollectionNames,
  InferCheckpointMap,
  TCollectionRuntimeRecord,
} from "../collection";
import type { BaseDBAdapter } from "../db-adapter/types";
import type { SyncOptions } from "../sync-handler";

export interface SyncClientConfig<
  C extends CollectionConfigMap<TCheckpoint>,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> {
  collections: C;
  dbAdapter: (schema: C) => DB;
  sync?: SyncOptions<
    ChangeBusEventDataMapFromCollectionConfigMap<C>,
    CollectionNames<C>,
    TCheckpoint
  >;
  checkpointStorage: ICheckpointStorage<CollectionNames<C>, TCheckpoint>;
}

export interface SyncClient<
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint = InferCheckpointMap<C>,
> {
  collections: TCollectionRuntimeRecord<C>;
  subscribe: SubscribeFn<C>;
  liveQuery: LiveQueryFn<C, DB>;
  startSync: () => void;
  stopSync: () => void;
  getCheckpoint: <N extends CollectionNames<C>>(collection: N) => Promise<TCheckpoint | undefined>;
  saveCheckpoint: <N extends CollectionNames<C>>(
    collection: N,
    checkpoint: TCheckpoint,
  ) => Promise<void>;
}

export interface SubscribeFn<
  C extends CollectionConfigMap,
  TDataMap extends ChangeBusEventDataMap = ChangeBusEventDataMapFromCollectionConfigMap<C>,
> {
  (
    cb: (events: ChangeBusEvent<TDataMap>[]) => void,
    options?: ChangeBusSubscribeOptions,
  ): () => void;
  <N extends CollectionNames<C>>(
    collection: N,
    cb: (events: ChangeBusEvent<TDataMap, N>[]) => void,
    options?: ChangeBusSubscribeOptions,
  ): () => void;
  <N extends CollectionNames<C>>(
    collections: readonly N[],
    cb: (events: ChangeBusEvent<TDataMap, N>[]) => void,
    options?: ChangeBusSubscribeOptions,
  ): () => void;
}

export type LiveQueryFn<C extends CollectionConfigMap, DB extends BaseDBAdapter<C, any, any>> = <
  TResult,
>(options: {
  collections?: CollectionNames<C>[];
  query: (db: DB["queryBuilder"], schema: DB["querySchema"]) => TResult | PromiseLike<TResult>;
  onData: (data: TResult) => void;
}) => () => void;
