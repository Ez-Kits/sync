import { ChangeBus, type ChangeBusEventDataMapFromCollectionConfigMap } from "../change-bus";
import type { CollectionConfigMap } from "../collection";
import type { BaseDBAdapter } from "../db-adapter/types";
import { SyncClientImpl } from "./sync-client";
import type { SyncClient, SyncClientConfig } from "./types";

export function createSyncClient<
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
>(config: SyncClientConfig<C, DB, TCheckpoint>): SyncClient<C, DB, TCheckpoint> {
  const bus = new ChangeBus<ChangeBusEventDataMapFromCollectionConfigMap<C>>();

  return new SyncClientImpl<C, DB, TCheckpoint>(config, bus);
}
