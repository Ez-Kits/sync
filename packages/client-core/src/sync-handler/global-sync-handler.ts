import type { ChangeBusEvent } from "../change-bus";
import type { CollectionConfigMap, CollectionNames } from "../collection";
import type { BaseDBAdapter } from "../db-adapter";
import {
  BaseSyncHandler,
  type BaseSyncHandlerConfig,
  type SyncHandlerDataMap,
} from "./base-sync-handler";
import type { SyncOptions } from "./types";

export interface GlobalSyncHandlerConfig<
  C extends CollectionConfigMap<TCheckpoint>,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> extends BaseSyncHandlerConfig<C, DB, TCheckpoint> {
  sync?: SyncOptions<SyncHandlerDataMap<C>, CollectionNames<C>, TCheckpoint>;
}

export class GlobalSyncHandler<
  C extends CollectionConfigMap<TCheckpoint>,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> extends BaseSyncHandler<C, DB, TCheckpoint> {
  private pullCleanup: (() => void) | undefined;
  private pushUnsubscribe: (() => void) | undefined;
  private startToken: object | undefined;

  constructor(protected override readonly config: GlobalSyncHandlerConfig<C, DB, TCheckpoint>) {
    super(config);
  }

  start(): void {
    const sync = this.config.sync;
    if (!sync) return;
    if (this.pullCleanup || this.pushUnsubscribe || this.startToken) return;

    const startToken = {};
    this.startToken = startToken;

    void (async () => {
      try {
        for (const collection of this.config.collections) {
          const collectionName = collection.name as CollectionNames<C>;
          await this.flushPendingPushEvents(
            collectionName,
            sync as SyncOptions<SyncHandlerDataMap<C>, CollectionNames<C>, TCheckpoint>,
            (events) => this.commitPushChanges(events),
          );
        }

        if (this.startToken !== startToken) return;

        const checkpointMap = await this.readCheckpointMap();
        const cleanup = sync.pull({
          checkpoint: checkpointMap,
          commitChanges: ({ changes, checkpoint }) => {
            void this.commitPullChanges(changes, checkpoint);
          },
        });
        if (typeof cleanup === "function") {
          this.pullCleanup = cleanup;
        }

        this.pushUnsubscribe = this.config.changeBus.subscribe(
          (events) => {
            sync.push({
              events,
              commitChanges: ({ events: committedEvents }) => {
                void this.commitPushChanges(committedEvents);
              },
            });
          },
          { stream: "local" },
        );
      } finally {
        if (this.startToken === startToken) {
          this.startToken = undefined;
        }
      }
    })();
  }

  stop(): void {
    this.startToken = undefined;

    this.pullCleanup?.();
    this.pullCleanup = undefined;

    this.pushUnsubscribe?.();
    this.pushUnsubscribe = undefined;
  }

  private async commitPullChanges(
    changes: ChangeBusEvent<SyncHandlerDataMap<C>>[],
    checkpoint: Partial<Record<CollectionNames<C>, TCheckpoint>>,
  ): Promise<void> {
    for (const event of changes) {
      await this.applyAnyCollectionEvent(event);
    }

    this.config.changeBus.publishRemoteBatch(changes);
    await this.saveCheckpointMap(checkpoint);
  }

  private async commitPushChanges(events: ChangeBusEvent<SyncHandlerDataMap<C>>[]): Promise<void> {
    await this.ackPushedEvents(events);
  }
}
