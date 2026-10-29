import type {
  ChangeBus,
  ChangeBusEvent,
  ChangeBusEventDataMapFromCollectionConfigMap,
} from "../change-bus";
import type { ICheckpointStorage } from "../checkpoint-storage";
import type { CollectionConfigMap, CollectionNames, ConfigForName } from "../collection";
import type {
  BaseDBAdapter,
  DBAdapterOperations,
  DBAdapterTransactionContext,
} from "../db-adapter";
import type { DirtyRecordKey, DirtyRecordState, ILocalChangeStore } from "../local-change-store";
import type { ConflictResolution, SyncAdapter } from "./types";

export type SyncHandlerDataMap<C extends CollectionConfigMap> =
  ChangeBusEventDataMapFromCollectionConfigMap<C>;

export interface BaseSyncHandlerConfig<
  C extends CollectionConfigMap<TCheckpoint>,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> {
  collections: C;
  db: DB;
  changeBus: ChangeBus<SyncHandlerDataMap<C>>;
  checkpointStorage: ICheckpointStorage<CollectionNames<C>, TCheckpoint>;
  localChangeStore: ILocalChangeStore;
  onSyncError?: (error: unknown) => void;
  onSyncSuccess?: () => void;
  /** Decides remote changes to records with pending local writes; without it they stay local. */
  conflictResolver?: ConflictResolution<SyncHandlerDataMap<C>>;
  /** Called with the pulled changes as applied locally (after conflict resolution), e.g. to notify other tabs. */
  onRemoteChangesCommitted?: (changes: ChangeBusEvent<SyncHandlerDataMap<C>>[]) => void;
  /** Fencing check: when it returns false this handler lost leadership and must not write. */
  canCommit?: () => boolean;
}

export abstract class BaseSyncHandler<
  C extends CollectionConfigMap<TCheckpoint>,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> {
  protected readonly collectionMap: Map<CollectionNames<C>, C[number]>;
  private pushQueues = new Map<string, Promise<void>>();

  constructor(protected readonly config: BaseSyncHandlerConfig<C, DB, TCheckpoint>) {
    this.collectionMap = new Map(
      config.collections.map((collection) => [collection.name, collection]),
    );
  }

  /** Serialize provider pushes and retry failures without acknowledging events. */
  protected enqueuePush(
    key: string,
    push: () => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const previous = this.pushQueues.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        let delayMs = 250;
        while (!signal?.aborted) {
          try {
            await push();
            this.config.onSyncSuccess?.();
            return;
          } catch (error) {
            if (signal?.aborted) return;
            this.config.onSyncError?.(error);
            if (!(await waitOrAbort(delayMs, signal))) return;
            delayMs = Math.min(delayMs * 2, 8_000);
          }
        }
      });
    this.pushQueues.set(key, next);
    void next.finally(() => {
      if (this.pushQueues.get(key) === next) this.pushQueues.delete(key);
    });
    return next;
  }

  /**
   * Keep a pull listener alive across provider errors while retaining checkpoint safety.
   *
   * Every subscription is one stream. `onError` fails it: the listener is torn down and a new
   * stream resubscribes from the persisted checkpoint after a backoff. `isActive` turns false
   * once the stream failed or the pull stopped; nothing it delivers afterwards may be
   * committed, since providers only send what came after their own last batch.
   */
  protected retryPull(
    subscribe: (
      onError: (error: unknown) => void,
      isActive: () => boolean,
    ) => void | (() => void) | Promise<void | (() => void)>,
  ): () => void {
    let active = true;
    let connecting = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let currentStream: object | undefined;
    let currentCleanup: (() => void) | undefined;
    let retryDelayMs = 250;

    const scheduleReconnect = () => {
      if (!active || retryTimer !== undefined) return;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void connect();
      }, retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, 8_000);
    };

    const failStream = (stream: object, error: unknown) => {
      if (!active) return;
      this.config.onSyncError?.(error);
      // A stream that already failed has been replaced; its errors only get reported.
      if (currentStream !== stream) return;
      currentStream = undefined;
      const cleanup = currentCleanup;
      currentCleanup = undefined;
      cleanup?.();
      scheduleReconnect();
    };

    const connect = async () => {
      if (!active || connecting) return;
      connecting = true;
      const cleanup = currentCleanup;
      currentCleanup = undefined;
      cleanup?.();
      const stream = {};
      currentStream = stream;
      try {
        const unsubscribe = await subscribe(
          (error) => failStream(stream, error),
          () => active && currentStream === stream,
        );
        if (active && currentStream === stream) {
          if (typeof unsubscribe === "function") currentCleanup = unsubscribe;
          retryDelayMs = 250;
          this.config.onSyncSuccess?.();
        } else {
          unsubscribe?.();
          // It failed while connecting, when a retry that fired was skipped.
          scheduleReconnect();
        }
      } catch (error) {
        failStream(stream, error);
        scheduleReconnect();
      } finally {
        connecting = false;
      }
    };

    void connect();
    return () => {
      active = false;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      currentCleanup?.();
      currentCleanup = undefined;
    };
  }

  protected async applyEvent<N extends CollectionNames<C>>(
    collectionName: N,
    event: ChangeBusEvent<SyncHandlerDataMap<C>, N>,
    db: DBAdapterOperations<C> = this.config.db,
  ): Promise<void> {
    const collectionConfig = this.collectionMap.get(collectionName) as
      | ConfigForName<C, N>
      | undefined;
    if (!collectionConfig) return;

    if (event.type === "delete") {
      await db.delete(collectionName, event.id as never);
      return;
    }

    await this.upsertRow(
      collectionName,
      collectionConfig,
      event.data as Record<string, unknown>,
      db,
    );
  }

  protected async applyAnyCollectionEvent(
    event: ChangeBusEvent<SyncHandlerDataMap<C>>,
    db: DBAdapterOperations<C> = this.config.db,
  ): Promise<void> {
    await this.applyEvent(event.collection as CollectionNames<C>, event as never, db);
  }

  /**
   * Apply one pulled batch in a single transaction, announce what it applied and save its
   * checkpoint. Resolves `true` when conflict resolution queued an outbox event to push.
   */
  protected async commitPulledChanges(
    changes: ChangeBusEvent<SyncHandlerDataMap<C>>[],
    checkpoint: Partial<Record<CollectionNames<C>, TCheckpoint>>,
    apply: (
      event: ChangeBusEvent<SyncHandlerDataMap<C>>,
      tx: DBAdapterOperations<C>,
    ) => Promise<void>,
  ): Promise<boolean> {
    let applied: ChangeBusEvent<SyncHandlerDataMap<C>>[] = [];
    let needsPush = false;
    if (changes.length > 0) {
      await this.config.db.transaction(async (tx, context) => {
        applied = [];
        needsPush = false;
        for (const event of changes) {
          const resolved = await this.resolveRemoteEvent(event, context);
          needsPush ||= resolved.needsPush;
          if (!resolved.event) continue;
          await apply(resolved.event, tx);
          applied.push(resolved.event);
        }
      });
    }

    this.config.changeBus.publishRemoteBatch(applied);
    if (applied.length > 0) this.config.onRemoteChangesCommitted?.(applied);
    await this.saveCheckpointMap(checkpoint);
    this.config.onSyncSuccess?.();
    return needsPush;
  }

  /**
   * Reconcile a pulled event with the record's pending local writes. Runs inside the pull
   * transaction, so every read and write goes through `context`. A record without pending
   * writes takes the remote event as is; otherwise the conflict resolver decides, and without
   * one the local state is kept:
   * - `"local"`: skip the remote event; the pending writes are pushed later.
   * - `"remote"`: apply it and drop the pending writes, so they never overwrite it.
   * - `{ data }`: apply the merged data and replace the pending writes with one event that
   *   pushes it: a create when the remote deleted the record, an update otherwise.
   *
   * A push in flight may already hold the replaced writes. Its acknowledgement deletes only the
   * ids it sent and recomputes the dirty state from what remains, so a merged event stays
   * pending and is pushed after it. What the provider accepted cannot be taken back, though: it
   * lands remotely after the decision and, like any remote write, comes back through pull,
   * where both sides converge on it.
   */
  protected async resolveRemoteEvent(
    event: ChangeBusEvent<SyncHandlerDataMap<C>>,
    context: DBAdapterTransactionContext<C>,
  ): Promise<{ event?: ChangeBusEvent<SyncHandlerDataMap<C>>; needsPush: boolean }> {
    const collection = event.collection as CollectionNames<C>;
    const primaryField = this.primaryFieldName(collection);
    const recordId = String(
      event.type === "delete" ? event.id : (event.data as Record<string, unknown>)[primaryField],
    );
    const key = { collection: String(collection), recordId };
    const store = this.config.localChangeStore;
    const { native, operations } = context;
    const dirty = await store.getDirtyRecords(key, native);
    const pending = await store.getPendingEvents(key, native);
    if (dirty.length === 0 && pending.length === 0) return { event, needsPush: false };

    const resolver = this.config.conflictResolver;
    if (!resolver) return { needsPush: false };
    const local: SyncHandlerDataMap<C>[CollectionNames<C>]["record"] | undefined =
      operations.getOptional
        ? await operations.getOptional(collection, coerceRecordId(recordId) as never)
        : await operations.get(collection, coerceRecordId(recordId) as never);
    const resolution = await resolver({ remote: event, local });
    if (resolution === "local") return { needsPush: false };

    await store.deleteEvents(
      pending.map(({ id }) => id),
      native,
    );
    if (resolution === "remote") {
      await store.removeDirtyRecords([key], native);
      return { event, needsPush: false };
    }

    const type = event.type === "delete" ? "create" : "update";
    const now = Date.now();
    await store.appendEvents(
      [{ id: crypto.randomUUID(), type, ...key, data: resolution.data, createdAt: now }],
      native,
    );
    await store.upsertDirtyRecord({ ...key, state: "dirty", updatedAt: now }, native);
    const merged =
      event.type === "delete"
        ? { type, collection: event.collection, data: resolution.data }
        : { ...event, data: resolution.data };
    return { event: merged as ChangeBusEvent<SyncHandlerDataMap<C>>, needsPush: true };
  }

  /**
   * Build push events from pending ChangeBusEvents persisted in the local change store.
   * Used on sync start to flush changes made while offline / before sync.
   */
  protected async collectPendingPushEvents<N extends CollectionNames<C>>(
    collectionName: N,
  ): Promise<ChangeBusEvent<SyncHandlerDataMap<C>, N>[]> {
    const storedEvents = await this.config.localChangeStore.getPendingEvents(
      String(collectionName),
    );

    return storedEvents.map((stored) => {
      if (stored.type === "delete") {
        return {
          type: "delete",
          collection: collectionName,
          id: coerceRecordId(stored.recordId),
          deletedAt: stored.createdAt,
          eventId: stored.id,
        } as ChangeBusEvent<SyncHandlerDataMap<C>, N>;
      }

      return {
        type: stored.type,
        collection: collectionName,
        data: stored.data,
        eventId: stored.id,
      } as ChangeBusEvent<SyncHandlerDataMap<C>, N>;
    });
  }

  protected async collectAllPendingPushEvents(): Promise<ChangeBusEvent<SyncHandlerDataMap<C>>[]> {
    const batches = await Promise.all(
      this.config.collections.map((collection) =>
        this.collectPendingPushEvents(collection.name as CollectionNames<C>),
      ),
    );
    return batches.flat();
  }

  /**
   * Push `events` and acknowledge what the provider accepted. Resolves only once every
   * acknowledgement started during the push has finished, awaited by the adapter or not, so
   * the next push reads the outbox after it; a failed one rejects, to be retried.
   */
  protected async pushAndAcknowledge<N extends CollectionNames<C>>(
    syncAdapter: SyncAdapter<SyncHandlerDataMap<C>, N, TCheckpoint>,
    events: ChangeBusEvent<SyncHandlerDataMap<C>, N>[],
  ): Promise<void> {
    const acknowledgements: Promise<void>[] = [];
    let pushError: { error: unknown } | undefined;
    try {
      await syncAdapter.push({
        events,
        commitChanges: ({ events: committedEvents }) => {
          const acknowledgement = this.ackPushedEvents(committedEvents);
          // Observed below, even when the adapter neither awaits it nor finishes pushing.
          acknowledgement.catch(() => undefined);
          acknowledgements.push(acknowledgement);
          return acknowledgement;
        },
      });
    } catch (error) {
      pushError = { error };
    }
    const results = await Promise.allSettled(acknowledgements);
    if (pushError) throw pushError.error;
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  protected async flushPendingPushEvents<N extends CollectionNames<C>>(
    collectionName: N,
    syncAdapter: SyncAdapter<SyncHandlerDataMap<C>, N, TCheckpoint>,
    queueKey = String(collectionName),
    signal?: AbortSignal,
  ): Promise<void> {
    await this.enqueuePush(
      queueKey,
      async () => {
        const events = await this.collectPendingPushEvents(collectionName);
        if (events.length === 0) return;
        await this.pushAndAcknowledge(syncAdapter, events);
      },
      signal,
    );
  }

  /**
   * After a successful push, remove acked events from the local store and refresh dirty
   * tracking, in one transaction: a failure part way leaves the outbox as it was.
   */
  protected async ackPushedEvents(events: ChangeBusEvent<SyncHandlerDataMap<C>>[]): Promise<void> {
    if (!this.mayCommit()) return;
    const eventIds = events
      .map((event) => event.eventId)
      .filter((eventId): eventId is string => typeof eventId === "string");

    const affectedKeys = new Map<string, DirtyRecordKey>();
    for (const event of events) {
      const collection = String(event.collection);
      const recordId =
        event.type === "delete"
          ? String(event.id)
          : String(
              (event.data as Record<string, unknown>)[this.primaryFieldName(event.collection)],
            );
      affectedKeys.set(`${collection}\0${recordId}`, { collection, recordId });
    }

    const store = this.config.localChangeStore;
    await this.config.db.transaction(async (_tx, { native }) => {
      if (eventIds.length > 0) await store.deleteEvents(eventIds, native);

      const keysToRemove: DirtyRecordKey[] = [];
      for (const key of affectedKeys.values()) {
        const remaining = await store.getPendingEvents(key, native);
        if (remaining.length === 0) {
          keysToRemove.push(key);
          continue;
        }

        const latest = remaining[remaining.length - 1]!;
        const state: DirtyRecordState = latest.type === "delete" ? "deleted" : "dirty";
        await store.upsertDirtyRecord(
          { collection: key.collection, recordId: key.recordId, state, updatedAt: Date.now() },
          native,
        );
      }

      if (keysToRemove.length > 0) await store.removeDirtyRecords(keysToRemove, native);
    });
  }

  protected mayCommit(): boolean {
    return this.config.canCommit?.() ?? true;
  }

  protected async readCheckpointMap(): Promise<Partial<Record<CollectionNames<C>, TCheckpoint>>> {
    const checkpointMap: Partial<Record<CollectionNames<C>, TCheckpoint>> = {};
    for (const collection of this.config.collections) {
      const collectionName = collection.name as CollectionNames<C>;
      const checkpoint = await this.config.checkpointStorage.getCheckpoint(collectionName);
      if (checkpoint !== undefined) {
        checkpointMap[collectionName] = checkpoint;
      }
    }
    return checkpointMap;
  }

  protected async saveCheckpointMap(
    checkpointMap: Partial<Record<CollectionNames<C>, TCheckpoint>>,
  ): Promise<void> {
    for (const collection of this.config.collections) {
      const collectionName = collection.name as CollectionNames<C>;
      const checkpoint = checkpointMap[collectionName];
      if (checkpoint === undefined) continue;
      await this.config.checkpointStorage.saveCheckpoint(collectionName, checkpoint);
    }
  }

  private primaryFieldName(collectionName: keyof SyncHandlerDataMap<C>): string {
    const collectionConfig = this.collectionMap.get(collectionName as CollectionNames<C>);
    return String(collectionConfig?.primaryField ?? "id");
  }

  private async upsertRow<N extends CollectionNames<C>>(
    collectionName: N,
    collectionConfig: ConfigForName<C, N>,
    row: Record<string, unknown>,
    db: DBAdapterOperations<C>,
  ): Promise<void> {
    const primaryField = collectionConfig.primaryField;
    const id = row[String(primaryField)];
    if (id !== undefined) {
      if (db.getOptional) {
        const existing = await db.getOptional(collectionName, id as never);
        if (existing !== undefined) {
          await db.update(collectionName, row as never);
          return;
        }
        await db.insert(collectionName, row as never);
        return;
      }
      const existing = await db.get(collectionName, id as never);
      if (existing !== undefined) {
        await db.update(collectionName, row as never);
        return;
      }
    }
    await db.insert(collectionName, row as never);
  }
}

/**
 * Coerce a stringified record id back to number when it looks numeric.
 * Primary keys are stored as strings in IndexedDB for indexing.
 */
function coerceRecordId(recordId: string): string | number {
  if (recordId !== "" && !Number.isNaN(Number(recordId)) && String(Number(recordId)) === recordId) {
    return Number(recordId);
  }
  return recordId;
}

function waitOrAbort(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
