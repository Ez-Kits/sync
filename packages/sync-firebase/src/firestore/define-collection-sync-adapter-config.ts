import type {
  CollectionConfig,
  InferCollectionCheckpoint,
  InferCollectionInsertModel,
  InferCollectionPrimaryFieldType,
  InferCollectionSelectModel,
  InferCollectionUpdateModel,
} from "@ez-kits/sync-client-core";
import type {
  FirestoreSyncAdapterCollectionConfig,
  FirestoreCollectionSyncAdapterConfigInput,
} from "./types.ts";

type EventMapFromCollectionConfig<Col extends CollectionConfig<any, any, any, any, any, any>> =
  Record<
    Col["name"],
    {
      create: InferCollectionInsertModel<Col>;
      update: InferCollectionUpdateModel<Col>;
      delete: InferCollectionPrimaryFieldType<Col>;
      record: InferCollectionSelectModel<Col>;
    }
  >;

/**
 * Define per-collection Firestore sync config for use with
 * {@link createFirestoreSyncAdapter}.
 */
export function defineFirestoreCollectionSyncAdapterConfig<
  Col extends CollectionConfig<any, any, any, any, any, any, any>,
>(
  config: FirestoreCollectionSyncAdapterConfigInput<Col>,
): FirestoreSyncAdapterCollectionConfig<
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
