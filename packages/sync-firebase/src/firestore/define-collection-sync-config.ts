import type {
  CollectionConfig,
  InferCollectionCheckpoint,
  InferCollectionInsertModel,
  InferCollectionPrimaryFieldType,
  InferCollectionUpdateModel,
} from "@ez-kits/sync-client-core";
import type { FirestoreCollectionSyncConfig, FirestoreCollectionSyncConfigInput } from "./types.ts";

type EventMapFromCollectionConfig<Col extends CollectionConfig<any, any, any, any, any, any>> =
  Record<
    Col["name"],
    {
      create: InferCollectionInsertModel<Col>;
      update: InferCollectionUpdateModel<Col>;
      delete: InferCollectionPrimaryFieldType<Col>;
    }
  >;

/**
 * Define per-collection Firestore sync config for use with
 * {@link createFirestoreSyncOptions}.
 */
export function defineFirestoreCollectionSyncConfig<
  Col extends CollectionConfig<any, any, any, any, any, any, any>,
>(
  config: FirestoreCollectionSyncConfigInput<Col>,
): FirestoreCollectionSyncConfig<
  EventMapFromCollectionConfig<Col>,
  Col["name"],
  InferCollectionCheckpoint<Col>
> {
  const { collectionConfig, ...rest } = config;
  return {
    ...rest,
    collectionName: collectionConfig.name,
  };
}
