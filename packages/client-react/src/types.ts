import type {
  BaseDBAdapter,
  CollectionConfigMap,
  CollectionNames,
  InferCheckpointMap,
  SyncClient,
  SyncClientConfig,
} from "@ez-kits/sync-client-core";
import type { ComponentType, ReactNode } from "react";
import type { AtomicLocalChangeStore } from "@ez-kits/sync-client-core";

export interface CreateSyncClientReactResult<
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint = InferCheckpointMap<C>,
> {
  syncClient: SyncClient<C, DB, TCheckpoint>;
  SyncClientProvider: ComponentType<{
    children: ReactNode;
  }>;
  useSyncClient: () => SyncClient<C, DB, TCheckpoint>;
  useLiveQuery: UseLiveQuery<C, DB>;
}

export interface CreateSyncClientReactOptions<
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
  Store extends AtomicLocalChangeStore,
> extends SyncClientConfig<C, DB, TCheckpoint, Store> {}

export type UseLiveQuery<C extends CollectionConfigMap, DB extends BaseDBAdapter<C, any, any>> = <
  TResult,
>(
  options: UseLiveQueryOptions<CollectionNames<C>, DB, TResult>,
) => UseLiveQueryResult<TResult>;

export interface UseLiveQueryOptions<
  TCollectionName,
  DB extends BaseDBAdapter<any, any, any>,
  TResult,
> {
  collections?: TCollectionName[];
  query: (db: DB["queryBuilder"], schema: DB["querySchema"]) => TResult | PromiseLike<TResult>;
}

export interface UseLiveQueryResult<TResult> {
  data: TResult | undefined;
  isPending: boolean;
  error: Error | undefined;
}
