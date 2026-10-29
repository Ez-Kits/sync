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
        const unsubscribe = this.startPushLoop(collectionName);
        if (unsubscribe) this.pushUnsubscribes.set(collectionName, unsubscribe);

        // Starting sync retries the collection's parked events at once.
        this.retryParkedOnNextPush(String(collectionName));
        void this.flushPendingPushEvents(collectionName, syncAdapter, pushController.signal).catch(
          (error) => this.config.onSyncError?.(error),
        );

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

    this.pushControllers.get(collectionName)?.abort();
    this.pushControllers.delete(collectionName);
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

  /** Push outbox events written outside this context, such as by another tab. */
  notifyOutboxChanged(collectionNames: readonly CollectionNames<C>[]): void {
    for (const collectionName of new Set(collectionNames)) {
      this.schedulePush(collectionName);
    }
  }

  /** Retry the parked events of every started collection now. */
  retryRejectedPushes(): void {
    for (const collectionName of this.pushControllers.keys()) {
      this.retryParkedOnNextPush(String(collectionName));
      this.schedulePush(collectionName);
    }
  }

  protected requestPush(queueKey: string): void {
    this.schedulePush(queueKey as CollectionNames<C>);
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
            void this.commitPullChanges(collectionName, options.changes, options.checkpoint, {
              isActive,
              onError,
            });
          },
          onError,
        });
      }),
    );
  }

  private startPushLoop<N extends CollectionNames<C>>(collectionName: N): (() => void) | undefined {
    return this.config.changeBus.subscribe(
      collectionName,
      (_events) => this.schedulePush(collectionName),
      { stream: "local" },
    );
  }

  private schedulePush<N extends CollectionNames<C>>(collectionName: N): void {
    const syncAdapter = this.collectionMap.get(collectionName)?.syncAdapter as
      | SyncAdapter<SyncHandlerDataMap<C>, N, TCheckpoint>
      | undefined;
    const pushController = this.pushControllers.get(collectionName);
    if (!syncAdapter || !pushController) return;

    const queueKey = String(collectionName);
    void this.enqueuePush(
      queueKey,
      () =>
        this.collectPendingPushEvents(collectionName).then((events) =>
          this.pushPending(queueKey, syncAdapter, events, pushController.signal),
        ),
      pushController.signal,
    );
  }

  /** Queue a pulled batch; one of a failed or stopped stream is dropped (see `retryPull`). */
  private async commitPullChanges<N extends CollectionNames<C>>(
    collectionName: N,
    changes: ChangeBusEvent<SyncHandlerDataMap<C>, N>[],
    checkpoint: Partial<Record<N, TCheckpoint>>,
    stream: { isActive: () => boolean; onError: (error: unknown) => void },
  ): Promise<void> {
    const previous = this.pullCommitQueues.get(collectionName) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (!this.mayCommit() || !stream.isActive()) return;
        const needsPush = await this.commitPulledChanges(
          changes as ChangeBusEvent<SyncHandlerDataMap<C>>[],
          checkpoint,
          (event, tx) => this.applyEvent(collectionName, event as never, tx),
        );
        if (needsPush) this.schedulePush(collectionName);
      });
    // A failed batch fails its stream, which resubscribes from the persisted checkpoint.
    const safeNext = next.catch((error) => stream.onError(error));
    this.pullCommitQueues.set(collectionName, safeNext);
    return safeNext;
  }
}
