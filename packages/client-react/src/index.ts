import type {
  BaseDBAdapter,
  CollectionConfigMap,
  CollectionNames,
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

export function createSyncClientReact<
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
>(
  options: CreateSyncClientReactOptions<C, DB, TCheckpoint>,
): CreateSyncClientReactResult<C, DB, TCheckpoint> {
  const syncClient = createSyncClient(options);
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

    const result = useSyncExternalStore(
      useCallback(
        (cb) => {
          client.liveQuery({
            collections: options.collections,
            query: async (qb, schema) => {
              try {
                setIsPending(true);
                return await options.query(qb, schema);
              } finally {
                setIsPending(false);
              }
            },
            onData: (data) => {
              cb();
              dataRef.current = data;
            },
          });

          return () => {};
        },
        [options.collections, options.query],
      ),
      () => {
        return dataRef.current;
      },
    );

    return {
      data: result,
      isPending,
      error: undefined,
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
