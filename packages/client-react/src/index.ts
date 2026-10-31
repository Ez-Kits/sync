import type {
  BaseDBAdapter,
  CollectionConfigMap,
  CollectionNames,
  InferCheckpointMap,
} from "@ez-kits/sync-client-core";
import { createSyncClient } from "@ez-kits/sync-client-core";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  CreateSyncClientReactOptions,
  CreateSyncClientReactResult,
  UseLiveQueryOptions,
  UseLiveQueryResult,
} from "./types.ts";

export type * from "./types.ts";

export function createSyncClientReact<
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint = InferCheckpointMap<C>,
>(
  options: CreateSyncClientReactOptions<C, DB, TCheckpoint>,
): CreateSyncClientReactResult<C, DB, TCheckpoint> {
  const syncClient = createSyncClient<C, DB, TCheckpoint>(options);
  const SyncClientContext = createContext<ReturnType<
    typeof createSyncClient<C, DB, TCheckpoint>
  > | null>(null);

  function SyncClientProvider({ children }: { children: ReactNode }) {
    const value = useMemo(() => syncClient, []);
    return createElement(SyncClientContext.Provider, { value }, children);
  }

  function useSyncClient(): ReturnType<typeof createSyncClient<C, DB, TCheckpoint>> {
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
  const result: CreateSyncClientReactResult<C, DB, TCheckpoint> = {
    syncClient,
    SyncClientProvider,
    useSyncClient,
    useLiveQuery,
  };

  return result;
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
