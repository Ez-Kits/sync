import type { ChangeBusEventDataMap, SyncOptions } from "@ez-kits/sync-client-core";
import { collectionNameFromPath } from "../shared/collection-name.ts";
import type { CollectionKey } from "../shared/types.ts";
import { createFirestoreSyncOptionsFromResolved } from "./create-sync-options-from-resolved.ts";
import type { FirestoreCollectionSyncOptionsConfig } from "./types.ts";

/**
 * Create Firestore {@link SyncOptions} for a single collection
 * (`defineDrizzleCollection({ sync })`, etc.).
 */
export function createFirestoreCollectionSyncOptions<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
>(config: FirestoreCollectionSyncOptionsConfig<C, N, TCheckpoint>): SyncOptions<C, N, TCheckpoint> {
  const { db, includeMetadataChanges, collectionName, collectionPath, ...handlers } = config;
  return createFirestoreSyncOptionsFromResolved(
    db,
    [
      {
        ...handlers,
        collectionPath,
        collectionName: (collectionName ?? collectionNameFromPath(collectionPath)) as N,
      },
    ],
    { includeMetadataChanges },
  );
}
