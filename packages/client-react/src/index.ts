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
    const dataRef = useRef<TResult | undefined>(undefined);
    const [isPending, setIsPending] = useState(false);
    const [error, setError] = useState<Error | undefined>(undefined);
    const collectionKey = options.collections?.join("\0");
    const collections = useMemo(() => options.collections, [collectionKey]);

    const result = useSyncExternalStore(
      useCallback(
        (cb) => {
          return client.liveQuery({
            collections,
            query: async (qb, schema) => {
              try {
                setIsPending(true);
                setError(undefined);
                return await options.query(qb, schema);
              } catch (reason) {
                setError(reason instanceof Error ? reason : new Error(String(reason)));
                return undefined as TResult;
              } finally {
                setIsPending(false);
              }
            },
            onData: (data) => {
              dataRef.current = data;
              setIsPending(false);
              cb();
            },
          });
        },
        [collections, options.query],
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
