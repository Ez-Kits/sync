import type { ChangeBusEventDataMap, SyncOptions } from "@ez-kits/sync-client-core";
import { collectionNameFromPath } from "../shared/collection-name.ts";
import type { CollectionKey } from "../shared/types.ts";
import { createRealtimeDBSyncOptionsFromResolved } from "./create-sync-options-from-resolved.ts";
import type { RealtimeDBCollectionSyncOptionsConfig } from "./types.ts";

/**
 * Create Realtime DB {@link SyncOptions} for a single collection
 * (`defineDrizzleCollection({ sync })`, etc.).
 */
export function createRealtimeDBCollectionSyncOptions<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
>(
  config: RealtimeDBCollectionSyncOptionsConfig<C, N, TCheckpoint>,
): SyncOptions<C, N, TCheckpoint> {
  const { db, collectionName, collectionPath, ...handlers } = config;
  return createRealtimeDBSyncOptionsFromResolved(db, [
    {
      ...handlers,
      collectionPath,
      collectionName: (collectionName ?? collectionNameFromPath(collectionPath)) as N,
    },
  ]);
}
