import type {
  CollectionConfig,
  InferCollectionCheckpoint,
  InferCollectionInsertModel,
  InferCollectionPrimaryFieldType,
  InferCollectionUpdateModel,
} from "@ez-kits/sync-client-core";
import type {
  RealtimeDBSyncAdapterCollectionConfig,
  RealtimeDBCollectionSyncAdapterConfigInput,
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
 * {@link createRealtimeDBSyncAdapter}.
 */
export function defineRealtimeDBCollectionSyncAdapterConfig<
  Col extends CollectionConfig<any, any, any, any, any, any, any>,
>(
  config: RealtimeDBCollectionSyncAdapterConfigInput<Col>,
): RealtimeDBSyncAdapterCollectionConfig<
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
