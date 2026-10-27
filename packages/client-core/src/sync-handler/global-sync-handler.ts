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
  private pushController: AbortController | undefined;
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
        const pushController = new AbortController();
        this.pushController = pushController;
        this.pushUnsubscribe = this.config.changeBus.subscribe((_events) => this.schedulePush(), {
          stream: "local",
        });

        this.schedulePush();

        if (this.startToken !== startToken) return;

        this.pullCleanup = this.retryPull(async (onError, isActive) => {
          const checkpointMap = await this.readCheckpointMap();
          if (!isActive()) return;
          return syncAdapter.pull({
            checkpoint: checkpointMap,
            commitChanges: ({ changes, checkpoint }) => {
              void this.commitPullChanges(changes, checkpoint);
            },
            onError,
          });
        });
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
    this.pushController?.abort();
    this.pushController = undefined;

    this.pullCleanup?.();
    this.pullCleanup = undefined;

    this.pushUnsubscribe?.();
    this.pushUnsubscribe = undefined;
  }

  /** Push outbox events written outside this context, such as by another tab. */
  notifyOutboxChanged(): void {
    this.schedulePush();
  }

  private schedulePush(): void {
    const syncAdapter = this.config.syncAdapter;
    const pushController = this.pushController;
    if (!syncAdapter || !pushController) return;

    void this.enqueuePush(
      "global",
      () =>
        this.collectAllPendingPushEvents().then((events) => {
          if (events.length === 0) return;
          return syncAdapter.push({
            events,
            commitChanges: ({ events: committedEvents }) => {
              void this.commitPushChanges(committedEvents);
            },
          });
        }),
      pushController.signal,
    );
  }

  private async commitPullChanges(
    changes: ChangeBusEvent<SyncHandlerDataMap<C>>[],
    checkpoint: Partial<Record<CollectionNames<C>, TCheckpoint>>,
  ): Promise<void> {
    const next = this.pullCommitQueue
      .catch(() => undefined)
      .then(async () => {
        if (!this.mayCommit()) return;
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
        if (changes.length > 0) this.config.onRemoteChangesCommitted?.(changes);
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
