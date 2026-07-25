import type { ChangeBusEventDataMap, SyncOptions } from "@ez-kits/sync-client-core";
import type { CollectionKey } from "../shared/types.ts";
import { createFirestoreSyncOptionsFromResolved } from "./create-sync-options-from-resolved.ts";
import type { FirestoreSyncOptionsConfig } from "./types.ts";

/**
 * Create Firestore {@link SyncOptions} for a sync client
 * (`createSyncClient({ sync })`).
 *
 * Pass common options (`db`, …) plus per-collection configs from
 * {@link defineFirestoreCollectionSyncConfig}.
 */
export function createFirestoreSyncOptions<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
>(config: FirestoreSyncOptionsConfig<C, N, TCheckpoint>): SyncOptions<C, N, TCheckpoint> {
  const { db, collections, includeMetadataChanges } = config;
  return createFirestoreSyncOptionsFromResolved(db, collections, {
    includeMetadataChanges,
  });
}
