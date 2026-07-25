import type {
  CollectionConfig,
  InferCollectionCheckpoint,
  InferCollectionInsertModel,
  InferCollectionPrimaryFieldType,
  InferCollectionUpdateModel,
} from "@ez-kits/sync-client-core";
import type {
  RealtimeDBCollectionSyncConfig,
  RealtimeDBCollectionSyncConfigInput,
} from "./types.ts";

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
 * Define per-collection Realtime DB sync config for use with
 * {@link createRealtimeDBSyncOptions}.
 */
export function defineRealtimeDBCollectionSyncConfig<
  Col extends CollectionConfig<any, any, any, any, any, any, any>,
>(
  config: RealtimeDBCollectionSyncConfigInput<Col>,
): RealtimeDBCollectionSyncConfig<
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
