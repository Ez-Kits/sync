import type {
  BaseDBAdapter,
  CollectionConfigMap,
  CollectionNames,
  InferCheckpointMap,
  PendingWrites,
  SyncClient,
} from "@ez-kits/sync-client-core";
import { createSyncClient } from "@ez-kits/sync-client-core";
import {
  createContext,
  createElement,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Context,
  type ReactNode,
} from "react";
import { createScopedClients } from "./scoped-clients.ts";
import type {
  CreateScopedSyncClientReactOptions,
  CreateScopedSyncClientReactResult,
  CreateSyncClientReactOptions,
  CreateSyncClientReactResult,
  ScopedSyncClientProviderProps,
  UseLiveQueryOptions,
  UseLiveQueryResult,
  UsePendingWritesResult,
} from "./types.ts";

export type * from "./types.ts";

/** One client for the whole app, created now. The provider and hooks serve it. */
export function createSyncClientReact<
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint = InferCheckpointMap<C>,
>(
  options: CreateSyncClientReactOptions<C, DB, TCheckpoint>,
): CreateSyncClientReactResult<C, DB, TCheckpoint> {
  const SyncClientContext = createContext<SyncClient<C, DB, TCheckpoint> | null>(null);
  const syncClient = createSyncClient<C, DB, TCheckpoint>(options);

  function SyncClientProvider({ children }: { children: ReactNode }) {
    return createElement(SyncClientContext.Provider, { value: syncClient }, children);
  }

  return { syncClient, SyncClientProvider, ...createHooks(SyncClientContext) };
}

/**
 * One client per scope (e.g. per signed-in user), each with its own database and sync
 * adapter from `createConfig(scope)`. `<SyncClientProvider scope={uid}>` opens the scope's
 * client once its database is ready, and disposes the previous one when the scope changes.
 */
export function createScopedSyncClientReact<
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint = InferCheckpointMap<C>,
>(
  options: CreateScopedSyncClientReactOptions<C, DB, TCheckpoint>,
): CreateScopedSyncClientReactResult<C, DB, TCheckpoint> {
  type Client = SyncClient<C, DB, TCheckpoint>;
  const SyncClientContext = createContext<Client | null>(null);
  const clients = createScopedClients(options);

  function SyncClientProvider({ scope, fallback = null, children }: ScopedSyncClientProviderProps) {
    const [opened, setOpened] = useState<{ scope: string; client?: Client; error?: unknown }>();

    useEffect(() => {
      let active = true;
      const lease = clients.acquire(scope);
      lease.client.then(
        (client) => {
          if (active) setOpened({ scope, client });
        },
        (error: unknown) => {
          if (active) setOpened({ scope, error });
        },
      );
      return () => {
        active = false;
        lease.release();
      };
    }, [scope]);

    // Until the new scope opens, render nothing of the previous one.
    if (opened?.scope !== scope) return fallback;
    if (!opened.client) throw opened.error;
    return createElement(
      SyncClientContext.Provider,
      { value: opened.client },
      createElement(Fragment, { key: scope }, children),
    );
  }

  return { SyncClientProvider, ...createHooks(SyncClientContext) };
}

function createHooks<
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
>(SyncClientContext: Context<SyncClient<C, DB, TCheckpoint> | null>) {
  function useSyncClient(): SyncClient<C, DB, TCheckpoint> {
    const ctx = useContext(SyncClientContext);
    if (!ctx) {
      throw new Error("useSyncClient must be used within the createSyncClientReact Provider");
    }
    return ctx;
  }

  function useLiveQuery<TResult>(
    options: UseLiveQueryOptions<CollectionNames<C>, DB, TResult>,
  ): UseLiveQueryResult<TResult> {
    const client = useSyncClient();
    // The latest `query` runs on every rerun; only `collections` and `deps` re-subscribe.
    const queryRef = useRef(options.query);
    queryRef.current = options.query;
    const dataRef = useRef<TResult | undefined>(undefined);
    const [isPending, setIsPending] = useState(true);
    const [error, setError] = useState<Error | undefined>(undefined);
    const collectionKey = options.collections?.join("\0");
    const collections = useMemo(() => options.collections, [collectionKey]);
    const depsVersion = useDepsVersion(options.deps);

    const result = useSyncExternalStore(
      useCallback(
        (cb) => {
          let active = true;
          const unsubscribe = client.liveQuery({
            collections,
            query: async (qb, schema) => {
              if (active) {
                setIsPending(true);
                setError(undefined);
              }
              try {
                return await queryRef.current(qb, schema);
              } catch (reason) {
                if (active) setError(reason instanceof Error ? reason : new Error(String(reason)));
                return undefined as TResult;
              }
            },
            onData: (data) => {
              // A run that ends after re-subscribing would overwrite the new query's data.
              if (!active) return;
              dataRef.current = data;
              setIsPending(false);
              cb();
            },
          });
          return () => {
            active = false;
            unsubscribe();
          };
        },
        [client, collections, depsVersion],
      ),
      () => {
        return dataRef.current;
      },
    );

    return {
      data: result,
      isPending,
      error,
    };
  }

  function usePendingWrites(): UsePendingWritesResult<CollectionNames<C>> {
    const client = useSyncClient();
    const [state, setState] = useState<{
      client: SyncClient<C, DB, TCheckpoint>;
      pending: PendingWrites<CollectionNames<C>>;
    }>();
    useEffect(
      () => client.subscribePendingWrites((pending) => setState({ client, pending })),
      [client],
    );
    // A value read from the previous client (scope) is not shown for the new one.
    const pending = state?.client === client ? state.pending : undefined;
    return pending
      ? { ...pending, isPending: false }
      : { total: 0, rejected: 0, byCollection: {}, isPending: true };
  }

  return { useSyncClient, useLiveQuery, usePendingWrites };
}

/** A number that changes whenever an item of `deps` changes (compared with `Object.is`). */
function useDepsVersion(deps: readonly unknown[] | undefined): number {
  const ref = useRef({ deps, version: 0 });
  if (!sameDeps(ref.current.deps, deps)) ref.current = { deps, version: ref.current.version + 1 };
  return ref.current.version;
}

function sameDeps(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}
