import type { ChangeBusEventDataMap, SyncAdapter } from "@ez-kits/sync-client-core";
import { collectionNameFromPath } from "../shared/collection-name.ts";
import type { CollectionKey } from "../shared/types.ts";
import { createFirestoreSyncAdapterFromResolved } from "./create-sync-adapter-from-resolved.ts";
import type { FirestoreCollectionSyncAdapterConfig } from "./types.ts";

/**
 * Create Firestore {@link SyncAdapter} for a single collection
 * (`defineDrizzleCollection({ syncAdapter })`, etc.).
 */
export function createFirestoreCollectionSyncAdapter<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
>(config: FirestoreCollectionSyncAdapterConfig<C, N, TCheckpoint>): SyncAdapter<C, N, TCheckpoint> {
  const { db, includeMetadataChanges, collectionName, collectionPath, ...handlers } = config;
  return createFirestoreSyncAdapterFromResolved(
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
