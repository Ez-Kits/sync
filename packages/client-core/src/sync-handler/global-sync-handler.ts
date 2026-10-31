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
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> extends BaseSyncHandlerConfig<C, DB, TCheckpoint> {
  syncAdapter?: SyncAdapter<SyncHandlerDataMap<C>, CollectionNames<C>, TCheckpoint>;
}

/**
 * The collections a client-level adapter pushes: the ones it lists (every one when it lists
 * none), except those with an adapter of their own, which their own handler pushes.
 */
export function globalSyncCollections(
  collections: CollectionConfigMap<any>,
  syncAdapter: { collections?: readonly PropertyKey[] } | undefined,
): string[] {
  if (!syncAdapter) return [];
  const listed = syncAdapter.collections && new Set(syncAdapter.collections.map(String));
  return collections
    .filter(
      (collection) => !collection.syncAdapter && (!listed || listed.has(String(collection.name))),
    )
    .map(({ name }) => String(name));
}

export class GlobalSyncHandler<
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> extends BaseSyncHandler<C, DB, TCheckpoint> {
  private pullCleanup: (() => void) | undefined;
  private pushUnsubscribe: (() => void) | undefined;
  private pushController: AbortController | undefined;
  private startToken: object | undefined;
  private pullCommitQueue: Promise<void> = Promise.resolve();
  private readonly pushCollections: CollectionNames<C>[];

  constructor(protected override readonly config: GlobalSyncHandlerConfig<C, DB, TCheckpoint>) {
    super(config);
    this.pushCollections = globalSyncCollections(
      config.collections,
      config.syncAdapter,
    ) as CollectionNames<C>[];
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

        // Starting sync retries parked events at once.
        this.retryParkedOnNextPush("global");
        this.schedulePush();

        if (this.startToken !== startToken) return;

        this.pullCleanup = this.retryPull(async (onError, isActive) => {
          const checkpointMap = await this.readCheckpointMap();
          if (!isActive()) return;
          return syncAdapter.pull({
            checkpoint: checkpointMap,
            commitChanges: ({ changes, checkpoint }) => {
              void this.commitPullChanges(changes, checkpoint, { isActive, onError });
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

  /** Retry the parked events now, when started. */
  retryRejectedPushes(): void {
    this.retryParkedOnNextPush("global");
    this.schedulePush();
  }

  protected requestPush(): void {
    this.schedulePush();
  }

  private schedulePush(): void {
    const syncAdapter = this.config.syncAdapter;
    const pushController = this.pushController;
    if (!syncAdapter || !pushController) return;

    void this.enqueuePush(
      "global",
      () =>
        this.collectAllPendingPushEvents(this.pushCollections).then((events) =>
          this.pushPending("global", syncAdapter, events, pushController.signal),
        ),
      pushController.signal,
    );
  }

  /** Queue a pulled batch; one of a failed or stopped stream is dropped (see `retryPull`). */
  private async commitPullChanges(
    changes: ChangeBusEvent<SyncHandlerDataMap<C>>[],
    checkpoint: Partial<Record<CollectionNames<C>, TCheckpoint>>,
    stream: { isActive: () => boolean; onError: (error: unknown) => void },
  ): Promise<void> {
    const next = this.pullCommitQueue
      .catch(() => undefined)
      .then(async () => {
        if (!this.mayCommit() || !stream.isActive()) return;
        const needsPush = await this.commitPulledChanges(changes, checkpoint, (event, tx) =>
          this.applyAnyCollectionEvent(event, tx),
        );
        if (needsPush) this.schedulePush();
      });
    // A failed batch fails its stream, which resubscribes from the persisted checkpoint.
    this.pullCommitQueue = next.catch((error) => stream.onError(error));
    return this.pullCommitQueue;
  }
}
