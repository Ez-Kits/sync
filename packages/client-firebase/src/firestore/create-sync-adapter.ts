import type { ChangeBusEventDataMap, SyncAdapter } from "@ez-kits/sync-client-core";
import type { CollectionKey } from "../shared/types.ts";
import { createFirestoreSyncAdapterFromResolved } from "./create-sync-adapter-from-resolved.ts";
import type { FirestoreSyncAdapterConfig } from "./types.ts";

/**
 * Create Firestore {@link SyncAdapter} for a sync client
 * (`createSyncClient({ syncAdapter })`).
 *
 * Pass common options (`db`, …) plus per-collection configs from
 * {@link defineFirestoreCollectionSyncAdapterConfig}.
 */
export function createFirestoreSyncAdapter<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
>(config: FirestoreSyncAdapterConfig<C, N, TCheckpoint>): SyncAdapter<C, N, TCheckpoint> {
  const { db, collections, includeMetadataChanges, checkpointSerializer } = config;
  return createFirestoreSyncAdapterFromResolved(db, collections, {
    includeMetadataChanges,
    checkpointSerializer,
  });
}
