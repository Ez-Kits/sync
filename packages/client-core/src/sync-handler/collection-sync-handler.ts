import type { ChangeBusEvent } from "../change-bus";
import type { CollectionConfigMap, CollectionNames } from "../collection";
import type { BaseDBAdapter } from "../db-adapter";
import {
  BaseSyncHandler,
  type BaseSyncHandlerConfig,
  type SyncHandlerDataMap,
} from "./base-sync-handler";
import type { SyncOptions } from "./types";

export type CollectionSyncHandlerConfig<
  C extends CollectionConfigMap<TCheckpoint>,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> = BaseSyncHandlerConfig<C, DB, TCheckpoint>;

export class CollectionSyncHandler<
  C extends CollectionConfigMap<TCheckpoint>,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> extends BaseSyncHandler<C, DB, TCheckpoint> {
  private pullCleanups = new Map<CollectionNames<C>, Array<() => void>>();
  private pushUnsubscribes = new Map<CollectionNames<C>, () => void>();
  private startTokens = new Map<CollectionNames<C>, object>();

  start<N extends CollectionNames<C>>(collectionName: N): void {
    if (
      this.pullCleanups.has(collectionName) ||
      this.pushUnsubscribes.has(collectionName) ||
      this.startTokens.has(collectionName)
    ) {
      return;
    }

    const collectionConfig = this.collectionMap.get(collectionName);
    if (!collectionConfig) return;

    const syncOptions = collectionConfig.sync as
      | SyncOptions<SyncHandlerDataMap<C>, N, TCheckpoint>
      | undefined;
    if (!syncOptions) return;

    const startToken = {};
    this.startTokens.set(collectionName, startToken);

    void (async () => {
      try {
        await this.flushPendingPushEvents(collectionName, syncOptions, (events) =>
          this.commitPushChanges(collectionName, events),
        );

        if (this.startTokens.get(collectionName) !== startToken) return;

        const pullCleanupList: Array<() => void> = [];
        this.pullCleanups.set(collectionName, pullCleanupList);
        this.startPullLoop(collectionName, syncOptions, pullCleanupList);

        const unsubscribe = this.startPushLoop(collectionName, syncOptions);
        if (unsubscribe) {
          this.pushUnsubscribes.set(collectionName, unsubscribe);
        }
      } finally {
        if (this.startTokens.get(collectionName) === startToken) {
          this.startTokens.delete(collectionName);
        }
      }
    })();
  }

  stop<N extends CollectionNames<C>>(collectionName: N): void {
    this.startTokens.delete(collectionName);

    const pullCleanupList = this.pullCleanups.get(collectionName) ?? [];
    for (const cleanup of pullCleanupList) cleanup();
    this.pullCleanups.delete(collectionName);

    const pushUnsubscribe = this.pushUnsubscribes.get(collectionName);
    pushUnsubscribe?.();
    this.pushUnsubscribes.delete(collectionName);
  }

  startAll(): void {
    for (const collection of this.config.collections) {
      this.start(collection.name as CollectionNames<C>);
    }
  }

  stopAll(): void {
    for (const collection of this.config.collections) {
      this.stop(collection.name as CollectionNames<C>);
    }
  }

  private startPullLoop<N extends CollectionNames<C>>(
    collectionName: N,
    syncOptions: SyncOptions<SyncHandlerDataMap<C>, N, TCheckpoint>,
    pullCleanupList: Array<() => void>,
  ): void {
    void (async () => {
      const checkpoint = await this.config.checkpointStorage.getCheckpoint(collectionName);
      const checkpointMap =
        checkpoint === undefined
          ? undefined
          : ({ [collectionName]: checkpoint } as Partial<Record<CollectionNames<C>, TCheckpoint>>);
      const cleanup = syncOptions.pull({
        checkpoint: checkpointMap as Partial<Record<N, TCheckpoint>> | undefined,
        commitChanges: (options) => {
          void this.commitPullChanges(collectionName, options.changes, options.checkpoint);
        },
      });
      if (typeof cleanup === "function") {
        pullCleanupList.push(cleanup);
      }
    })();
  }

  private startPushLoop<N extends CollectionNames<C>>(
    collectionName: N,
    syncOptions: SyncOptions<SyncHandlerDataMap<C>, N, TCheckpoint>,
  ): (() => void) | undefined {
    return this.config.changeBus.subscribe(
      collectionName,
      (events) => {
        syncOptions.push({
          events,
          commitChanges: ({ events: committedEvents }) => {
            void this.commitPushChanges(collectionName, committedEvents);
          },
        });
      },
      { stream: "local" },
    );
  }

  private async commitPullChanges<N extends CollectionNames<C>>(
    collectionName: N,
    changes: ChangeBusEvent<SyncHandlerDataMap<C>, N>[],
    checkpoint: Partial<Record<N, TCheckpoint>>,
  ): Promise<void> {
    for (const event of changes) {
      await this.applyEvent(collectionName, event);
    }

    this.config.changeBus.publishRemoteBatch(changes);
    await this.saveCheckpointMap(checkpoint);
  }

  private async commitPushChanges<N extends CollectionNames<C>>(
    _collectionName: N,
    events: ChangeBusEvent<SyncHandlerDataMap<C>, N>[],
  ): Promise<void> {
    await this.ackPushedEvents(events);
  }
}
