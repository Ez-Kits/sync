import type { ChangeBusEventDataMap, SyncOptions } from "@ez-kits/sync-client-core";
import type { CollectionKey } from "../shared/types.ts";
import { createRealtimeDBSyncOptionsFromResolved } from "./create-sync-options-from-resolved.ts";
import type { RealtimeDBSyncOptionsConfig } from "./types.ts";

/**
 * Create Realtime DB {@link SyncOptions} for a sync client
 * (`createSyncClient({ sync })`).
 *
 * Pass common options (`db`) plus per-collection configs from
 * {@link defineRealtimeDBCollectionSyncConfig}.
 */
export function createRealtimeDBSyncOptions<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
>(config: RealtimeDBSyncOptionsConfig<C, N, TCheckpoint>): SyncOptions<C, N, TCheckpoint> {
  const { db, collections } = config;
  return createRealtimeDBSyncOptionsFromResolved(db, collections);
}
