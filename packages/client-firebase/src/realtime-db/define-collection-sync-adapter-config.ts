import type { CollectionConfig } from "@ez-kits/sync-client-core";
import { assertDeleteIdHook } from "../shared/delete-id-hook.ts";
import type { EventMapFromCollectionConfig } from "../shared/types.ts";
import type {
  RealtimeDBSyncAdapterCollectionConfig,
  RealtimeDBCollectionSyncAdapterConfigInput,
} from "./types.ts";

/**
 * Define per-collection Realtime DB sync config for use with
 * {@link createRealtimeDBSyncAdapter}.
 */
export function defineRealtimeDBCollectionSyncAdapterConfig<
  Col extends CollectionConfig<any, any, any, any, any, any, any>,
  TCheckpoint,
>(
  config: RealtimeDBCollectionSyncAdapterConfigInput<Col, TCheckpoint>,
): RealtimeDBSyncAdapterCollectionConfig<
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
