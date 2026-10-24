import type { ChangeBusEvent } from "../change-bus";
import type { CollectionConfigMap, CollectionNames } from "../collection";
import type { BaseDBAdapter } from "../db-adapter";
import {
  BaseSyncHandler,
  type BaseSyncHandlerConfig,
  type SyncHandlerDataMap,
} from "./base-sync-handler";
import type { SyncAdapter } from "./types";

export interface GlobalSyncHandlerConfig<
  C extends CollectionConfigMap<TCheckpoint>,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> extends BaseSyncHandlerConfig<C, DB, TCheckpoint> {
  syncAdapter?: SyncAdapter<SyncHandlerDataMap<C>, CollectionNames<C>, TCheckpoint>;
}

export class GlobalSyncHandler<
  C extends CollectionConfigMap<TCheckpoint>,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> extends BaseSyncHandler<C, DB, TCheckpoint> {
  private pullCleanup: (() => void) | undefined;
  private pushUnsubscribe: (() => void) | undefined;
  private startToken: object | undefined;
  private pullCommitQueue: Promise<void> = Promise.resolve();

  constructor(protected override readonly config: GlobalSyncHandlerConfig<C, DB, TCheckpoint>) {
    super(config);
  }

  start(): void {
    const syncAdapter = this.config.syncAdapter;
    if (!syncAdapter) return;
    if (this.pullCleanup || this.pushUnsubscribe || this.startToken) return;

    const startToken = {};
    this.startToken = startToken;

    void (async () => {
      try {
        this.pushUnsubscribe = this.config.changeBus.subscribe(
          (_events) => {
            void this.enqueuePush("global", () =>
              this.collectAllPendingPushEvents().then((events) => {
                if (events.length === 0) return;
                return syncAdapter.push({
                  events,
                  commitChanges: ({ events: committedEvents }) => {
                    void this.commitPushChanges(committedEvents);
                  },
                });
              }),
            );
          },
          { stream: "local" },
        );

        for (const collection of this.config.collections) {
          const collectionName = collection.name as CollectionNames<C>;
          await this.flushPendingPushEvents(
            collectionName,
            syncAdapter as SyncAdapter<SyncHandlerDataMap<C>, CollectionNames<C>, TCheckpoint>,
            (events) => this.commitPushChanges(events),
            "global",
          );
        }

        if (this.startToken !== startToken) return;

        const checkpointMap = await this.readCheckpointMap();
        const cleanup = await syncAdapter.pull({
          checkpoint: checkpointMap,
          commitChanges: ({ changes, checkpoint }) => {
            void this.commitPullChanges(changes, checkpoint);
          },
        });
        if (typeof cleanup === "function") {
          this.pullCleanup = cleanup;
        }
      } catch (error) {
        this.config.onSyncError?.(error);
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
    const next = this.pullCommitQueue
      .catch(() => undefined)
      .then(async () => {
        if (changes.length > 0) {
          await this.config.db.transaction(async (tx) => {
            for (const event of changes) {
              const resolved = await this.resolveRemoteEvent(event);
              if (!resolved) continue;
              await this.applyAnyCollectionEvent(resolved, tx);
            }
          });
        }

        this.config.changeBus.publishRemoteBatch(changes);
        await this.saveCheckpointMap(checkpoint);
        this.config.onSyncSuccess?.();
      });
    this.pullCommitQueue = next.catch((error) => this.config.onSyncError?.(error));
    return this.pullCommitQueue;
  }

  private async commitPushChanges(events: ChangeBusEvent<SyncHandlerDataMap<C>>[]): Promise<void> {
    await this.ackPushedEvents(events);
  }
}
