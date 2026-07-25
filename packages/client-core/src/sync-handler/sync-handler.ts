import type { CollectionConfigMap, CollectionNames } from "../collection";
import type { BaseDBAdapter } from "../db-adapter";
import { type BaseSyncHandlerConfig, type SyncHandlerDataMap } from "./base-sync-handler";
import { CollectionSyncHandler } from "./collection-sync-handler";
import { GlobalSyncHandler } from "./global-sync-handler";
import type { SyncOptions } from "./types";

export interface SyncHandlerConfig<
  C extends CollectionConfigMap<TCheckpoint>,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> extends BaseSyncHandlerConfig<C, DB, TCheckpoint> {
  sync?: SyncOptions<SyncHandlerDataMap<C>, CollectionNames<C>, TCheckpoint>;
}

/**
 * Orchestrates global and per-collection sync handlers.
 */
export class SyncHandler<
  C extends CollectionConfigMap<TCheckpoint>,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> {
  private readonly globalSyncHandler: GlobalSyncHandler<C, DB, TCheckpoint>;
  private readonly collectionSyncHandler: CollectionSyncHandler<C, DB, TCheckpoint>;
  private isAllSyncStarted = false;

  constructor(config: SyncHandlerConfig<C, DB, TCheckpoint>) {
    this.globalSyncHandler = new GlobalSyncHandler(config);
    this.collectionSyncHandler = new CollectionSyncHandler(config);
  }

  startCollectionSync<N extends CollectionNames<C>>(collectionName: N): void {
    this.collectionSyncHandler.start(collectionName);
  }

  stopCollectionSync<N extends CollectionNames<C>>(collectionName: N): void {
    this.collectionSyncHandler.stop(collectionName);
  }

  startAll(): void {
    if (this.isAllSyncStarted) return;
    this.isAllSyncStarted = true;

    this.globalSyncHandler.start();
    this.collectionSyncHandler.startAll();
  }

  stopAll(): void {
    this.isAllSyncStarted = false;
    this.globalSyncHandler.stop();
    this.collectionSyncHandler.stopAll();
  }
}
