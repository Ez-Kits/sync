import type {
  CollectionConfig,
  InferCollectionInsertModel,
  InferCollectionPrimaryFieldType,
  InferCollectionSelectModel,
  InferCollectionUpdateModel,
} from "@ez-kits/sync-client-core";
import { assertDeleteIdHook } from "../shared/delete-id-hook.ts";
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
  TCheckpoint,
>(
  config: FirestoreCollectionSyncAdapterConfigInput<Col, TCheckpoint>,
): FirestoreSyncAdapterCollectionConfig<
  EventMapFromCollectionConfig<Col>,
  Col["name"],
  TCheckpoint
> {
  const { collectionConfig, ...rest } = config;
  assertDeleteIdHook(collectionConfig, rest.deserializeDeleteId);
  return {
    ...rest,
    collectionName: collectionConfig.name,
  };
}
