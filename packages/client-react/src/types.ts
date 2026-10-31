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

/**
 * Options of the scoped form: one client per scope (e.g. per signed-in user), built when
 * `SyncClientProvider` first renders that scope.
 */
export interface CreateScopedSyncClientReactOptions<
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> {
  /**
   * Build the whole client config of a scope: its own `DBStorage` (a storage `key` and a
   * database name per scope) and its own sync adapter (e.g. a per-user path). Called once
   * each time a scope is opened, never while the previous client of the same scope is still
   * closing, so both never hold one database at once.
   */
  createConfig: (scope: string) => SyncClientConfig<C, DB, TCheckpoint>;
}

export interface ScopedSyncClientProviderProps {
  /**
   * Which client to provide, e.g. the signed-in user's id. Changing it disposes the previous
   * scope's client and remounts `children`, so no component state crosses scopes.
   */
  scope: string;
  /** Rendered while the scope's database opens. Default: nothing. */
  fallback?: ReactNode;
  children: ReactNode;
}

export interface CreateScopedSyncClientReactResult<
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint = InferCheckpointMap<C>,
> {
  SyncClientProvider: ComponentType<ScopedSyncClientProviderProps>;
  useSyncClient: () => SyncClient<C, DB, TCheckpoint>;
  useLiveQuery: UseLiveQuery<C, DB>;
}

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
