import type { ChangeBusEvent } from "../change-bus";
import type { CollectionConfigMap, CollectionNames } from "../collection";
import type { BaseDBAdapter } from "../db-adapter";
import {
  BaseSyncHandler,
  type BaseSyncHandlerConfig,
  type SyncHandlerDataMap,
} from "./base-sync-handler";
import type { SyncAdapter } from "./types";

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
  private pushControllers = new Map<CollectionNames<C>, AbortController>();
  private startTokens = new Map<CollectionNames<C>, object>();
  private pullCommitQueues = new Map<CollectionNames<C>, Promise<void>>();

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

    const syncAdapter = collectionConfig.syncAdapter as
      | SyncAdapter<SyncHandlerDataMap<C>, N, TCheckpoint>
      | undefined;
    if (!syncAdapter) return;

    const startToken = {};
    this.startTokens.set(collectionName, startToken);

    void (async () => {
      try {
        const pushController = new AbortController();
        this.pushControllers.set(collectionName, pushController);
        const unsubscribe = this.startPushLoop(collectionName, syncAdapter, pushController.signal);
        if (unsubscribe) this.pushUnsubscribes.set(collectionName, unsubscribe);

        void this.flushPendingPushEvents(
          collectionName,
          syncAdapter,
          (events) => this.commitPushChanges(collectionName, events),
          String(collectionName),
          pushController.signal,
        ).catch((error) => this.config.onSyncError?.(error));

        if (this.startTokens.get(collectionName) !== startToken) return;

        const pullCleanupList: Array<() => void> = [];
        this.pullCleanups.set(collectionName, pullCleanupList);
        this.startPullLoop(collectionName, syncAdapter, pullCleanupList);
      } catch (error) {
        this.config.onSyncError?.(error);
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
    syncAdapter: SyncAdapter<SyncHandlerDataMap<C>, N, TCheckpoint>,
    pullCleanupList: Array<() => void>,
  ): void {
    pullCleanupList.push(
      this.retryPull(async (onError, isActive) => {
        const checkpoint = await this.config.checkpointStorage.getCheckpoint(collectionName);
        if (!isActive()) return;
        const checkpointMap =
          checkpoint === undefined
            ? undefined
            : ({
                [collectionName]: checkpoint,
              } as Partial<Record<CollectionNames<C>, TCheckpoint>>);
        return syncAdapter.pull({
          checkpoint: checkpointMap as Partial<Record<N, TCheckpoint>> | undefined,
          commitChanges: (options) => {
            void this.commitPullChanges(collectionName, options.changes, options.checkpoint);
          },
          onError,
        });
      }),
    );
  }

  private startPushLoop<N extends CollectionNames<C>>(
    collectionName: N,
    syncAdapter: SyncAdapter<SyncHandlerDataMap<C>, N, TCheckpoint>,
    signal: AbortSignal,
  ): (() => void) | undefined {
    return this.config.changeBus.subscribe(
      collectionName,
      (_events) => {
        void this.enqueuePush(
          String(collectionName),
          () =>
            this.collectPendingPushEvents(collectionName).then((events) => {
              if (events.length === 0) return;
              return syncAdapter.push({
                events,
                commitChanges: ({ events: committedEvents }) => {
                  void this.commitPushChanges(collectionName, committedEvents);
                },
              });
            }),
          signal,
        );
      },
      { stream: "local" },
    );
  }

  private async commitPullChanges<N extends CollectionNames<C>>(
    collectionName: N,
    changes: ChangeBusEvent<SyncHandlerDataMap<C>, N>[],
    checkpoint: Partial<Record<N, TCheckpoint>>,
  ): Promise<void> {
    const previous = this.pullCommitQueues.get(collectionName) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (changes.length > 0) {
          await this.config.db.transaction(async (tx) => {
            for (const event of changes) {
              const resolved = await this.resolveRemoteEvent(
                event as ChangeBusEvent<SyncHandlerDataMap<C>>,
              );
              if (!resolved) continue;
              await this.applyEvent(collectionName, resolved as never, tx);
            }
          });
        }

        this.config.changeBus.publishRemoteBatch(changes);
        await this.saveCheckpointMap(checkpoint);
        this.config.onSyncSuccess?.();
      });
    const safeNext = next.catch((error) => this.config.onSyncError?.(error));
    this.pullCommitQueues.set(collectionName, safeNext);
    return safeNext;
  }

  private async commitPushChanges<N extends CollectionNames<C>>(
    _collectionName: N,
    events: ChangeBusEvent<SyncHandlerDataMap<C>, N>[],
  ): Promise<void> {
    await this.ackPushedEvents(events);
  }
}
