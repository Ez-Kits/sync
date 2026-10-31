import type {
  BaseDBAdapter,
  CollectionConfigMap,
  CollectionNames,
  InferCheckpointMap,
  SyncClient,
  SyncClientConfig,
} from "@ez-kits/sync-client-core";
import type { ComponentType, ReactNode } from "react";

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
> extends SyncClientConfig<C, DB, TCheckpoint> {}

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
  /**
   * Reruns whenever the watched collections change. Need not be stable: the latest function
   * runs, and a new one alone does not start a new live query.
   */
  query: (db: DB["queryBuilder"], schema: DB["querySchema"]) => TResult | PromiseLike<TResult>;
  /**
   * Values `query` reads from the component (props, state), like `useEffect` dependencies.
   * When one changes, the live query restarts and reruns at once; otherwise the new value is
   * only used on the next change of the watched collections.
   */
  deps?: readonly unknown[];
}

export interface UseLiveQueryResult<TResult> {
  data: TResult | undefined;
  /** `true` until the first result, and while the query reruns. */
  isPending: boolean;
  error: Error | undefined;
}
