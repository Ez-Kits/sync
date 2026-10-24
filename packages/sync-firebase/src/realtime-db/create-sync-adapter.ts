import type { ChangeBusEventDataMap, SyncAdapter } from "@ez-kits/sync-client-core";
import type { CollectionKey } from "../shared/types.ts";
import { createRealtimeDBSyncAdapterFromResolved } from "./create-sync-adapter-from-resolved.ts";
import type { RealtimeDBSyncAdapterConfig } from "./types.ts";

/**
 * Create Realtime DB {@link SyncAdapter} for a sync client
 * (`createSyncClient({ syncAdapter })`).
 *
 * Pass common options (`db`) plus per-collection configs from
 * {@link defineRealtimeDBCollectionSyncAdapterConfig}.
 */
export function createRealtimeDBSyncAdapter<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
>(config: RealtimeDBSyncAdapterConfig<C, N, TCheckpoint>): SyncAdapter<C, N, TCheckpoint> {
  const { db, collections } = config;
  return createRealtimeDBSyncAdapterFromResolved(db, collections);
}
