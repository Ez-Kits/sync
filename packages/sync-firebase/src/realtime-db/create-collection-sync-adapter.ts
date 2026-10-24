import type { ChangeBusEventDataMap, SyncAdapter } from "@ez-kits/sync-client-core";
import { collectionNameFromPath } from "../shared/collection-name.ts";
import type { CollectionKey } from "../shared/types.ts";
import { createRealtimeDBSyncAdapterFromResolved } from "./create-sync-adapter-from-resolved.ts";
import type { RealtimeDBCollectionSyncAdapterConfig } from "./types.ts";

/**
 * Create Realtime DB {@link SyncAdapter} for a single collection
 * (`defineDrizzleCollection({ syncAdapter })`, etc.).
 */
export function createRealtimeDBCollectionSyncAdapter<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
>(
  config: RealtimeDBCollectionSyncAdapterConfig<C, N, TCheckpoint>,
): SyncAdapter<C, N, TCheckpoint> {
  const { db, collectionName, collectionPath, ...handlers } = config;
  return createRealtimeDBSyncAdapterFromResolved(db, [
    {
      ...handlers,
      collectionPath,
      collectionName: (collectionName ?? collectionNameFromPath(collectionPath)) as N,
    },
  ]);
}
