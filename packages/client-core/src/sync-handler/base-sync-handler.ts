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
import { LeaderChangedError } from "../db-storage/errors";
import type { DirtyRecordKey, DirtyRecordState, ILocalChangeStore } from "../local-change-store";
import { isPermanentPushError } from "./errors";
import type { ConflictResolution, PushRejection, SyncAdapter } from "./types";

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
  /**
   * Called when an event the provider rejected for good (see `PushRejectedError`) is parked:
   * it stays in the outbox, held with the later events of its record, and is retried. Only
   * `discard` removes it.
   */
  onPushRejected?: (rejection: PushRejection<SyncHandlerDataMap<C>>) => void;
}

export abstract class BaseSyncHandler<
  C extends CollectionConfigMap<TCheckpoint>,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> {
  protected readonly collectionMap: Map<CollectionNames<C>, C[number]>;
  private pushQueues = new Map<string, Promise<void>>();
  /**
   * Per record, the latest pulled event skipped because the record had pending local writes.
   * Its pending writes may already be on the remote, and that event may be their echo, with
   * server-assigned fields or a concurrent write the server applied after them. Pull will not
   * send it again past the saved checkpoint, so the acknowledgement that leaves the record
   * with no pending writes applies it. Pull delivers in server order: when the latest skipped
   * event predates the push, the push's own echo follows and is applied normally over it.
   * Any later remote event of the record replaces it, or clears it once applied or merged.
   *
   * Kept in memory: a reload, or a new leader, before that acknowledgement forgets it, and
   * the record then catches up with the remote on its next remote change. A pull transaction
   * that rolls back after updating it leaves remote state at least as old as what its stream
   * re-delivers from the checkpoint, so the next delivery corrects it.
   */
  private skippedRemoteEvents = new Map<string, ChangeBusEvent<SyncHandlerDataMap<C>>>();
  /**
   * Pending events the provider refused on their own, by event id. A parked event stays in the
   * outbox and is left out of pushes, with every later event of its record, so the record's
   * order holds while other records keep syncing. Parked events are retried after a backoff
   * and whenever sync starts; they leave the outbox only when acknowledged or discarded.
   *
   * Kept in memory: a reload or a new leader pushes them again, which is safe, since nothing
   * was written for them.
   */
  private parkedEvents = new Map<string, ParkedPush<SyncHandlerDataMap<C>>>();
  /** Parked event ids `onPushRejected` was called for, so a retry is not reported again. */
  private reportedRejections = new Set<string>();
  /** Queues whose next push starts with their parked events. */
  private parkedRetryDue = new Set<string>();
  private parkedRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private parkedRetryDelays = new Map<string, number>();
  /** Per queue, the event id of the last retry's probe (see `retryParked`). */
  private parkedProbes = new Map<string, string>();

  constructor(protected readonly config: BaseSyncHandlerConfig<C, DB, TCheckpoint>) {
    this.collectionMap = new Map(
      config.collections.map((collection) => [collection.name, collection]),
    );
  }

  /**
   * Schedule a push of the queue's pending events (`pushPending`); called when its parked
   * events are due or a discard released a record.
   */
  protected abstract requestPush(queueKey: string): void;

  /**
   * Serialize provider pushes and retry failures without acknowledging events. A push that
   * resolves `false` (events stay parked) does not report success.
   */
  protected enqueuePush(
    key: string,
    push: () => void | boolean | Promise<void | boolean>,
    signal?: AbortSignal,
  ): Promise<void> {
    const previous = this.pushQueues.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        let delayMs = 250;
        while (!signal?.aborted) {
          try {
            if ((await push()) !== false) this.config.onSyncSuccess?.();
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
   * - `"local"`: skip the remote event; the pending writes are pushed later. The skipped event
   *   is remembered for their acknowledgement (see `skippedRemoteEvents`).
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
    const key = this.dirtyRecordKey(event);
    const { recordId } = key;
    const skippedKey = recordKeyString(key);
    const store = this.config.localChangeStore;
    const { native, operations } = context;
    const dirty = await store.getDirtyRecords(key, native);
    const pending = await store.getPendingEvents(key, native);
    if (dirty.length === 0 && pending.length === 0) {
      this.skippedRemoteEvents.delete(skippedKey);
      return { event, needsPush: false };
    }

    const resolver = this.config.conflictResolver;
    if (!resolver) {
      this.skippedRemoteEvents.set(skippedKey, event);
      return { needsPush: false };
    }
    const local: SyncHandlerDataMap<C>[CollectionNames<C>]["record"] | undefined =
      operations.getOptional
        ? await operations.getOptional(collection, coerceRecordId(recordId) as never)
        : await operations.get(collection, coerceRecordId(recordId) as never);
    const resolution = await resolver({ remote: event, local });
    if (resolution === "local") {
      this.skippedRemoteEvents.set(skippedKey, event);
      return { needsPush: false };
    }
    // Applied, or merged into the pushed data: the remote state is no longer missing locally.
    this.skippedRemoteEvents.delete(skippedKey);

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

  /** Push the queue's parked events, and the queue's next push, first (see `parkedEvents`). */
  protected retryParkedOnNextPush(queueKey: string): void {
    this.parkedRetryDue.add(queueKey);
  }

  /**
   * Push a queue's pending `events` (all of them, in outbox order). Parked events, and later
   * events of their records, are left out, except when their retry is due: then the parked
   * events are retried first (`retryParked`). Resolves `false` while events stay parked.
   */
  protected async pushPending<N extends CollectionNames<C>>(
    queueKey: string,
    syncAdapter: SyncAdapter<SyncHandlerDataMap<C>, N, TCheckpoint>,
    events: ChangeBusEvent<SyncHandlerDataMap<C>, N>[],
    signal: AbortSignal,
  ): Promise<boolean> {
    // A parked event can leave the outbox without this handler, e.g. by a conflict decision.
    const pendingIds = new Set(events.map(({ eventId }) => eventId));
    for (const [eventId, parked] of this.parkedEvents) {
      if (parked.queueKey === queueKey && !pendingIds.has(eventId)) this.forgetParked(eventId);
    }

    const pass: PushPass = { queueKey, rejections: [] };
    let toPush = events;
    if (this.parkedRetryDue.has(queueKey)) {
      const parked = events.filter(({ eventId }) => this.parkedEvents.has(eventId as string));
      if (parked.length > 0 && (await this.retryParked(queueKey, syncAdapter, parked, pass))) {
        toPush = await this.pendingAmong(events);
      }
      this.parkedRetryDue.delete(queueKey);
    }
    toPush = toPush.filter(
      (event) => !this.parkedEvents.has(event.eventId as string) && !this.isHeld(event),
    );
    if (toPush.length > 0) await this.pushAndAcknowledge(syncAdapter, toPush, pass);

    if (pass.rejections.length > 0) this.config.onSyncError?.(pass.rejections.at(-1));
    const parked = [...this.parkedEvents.values()].some((entry) => entry.queueKey === queueKey);
    if (parked) this.scheduleParkedRetry(queueKey, signal);
    else {
      this.parkedRetryDelays.delete(queueKey);
      this.parkedProbes.delete(queueKey);
    }
    return !parked;
  }

  /**
   * Retry a queue's `parked` events, in outbox order, starting with one probe pushed alone.
   * Resolves whether the probe was accepted; only then are the other parked events pushed (and
   * narrowed down again if refused). A refused probe keeps everything parked and ends the
   * retry, so a client whose every write is refused, e.g. signed out, costs one provider write
   * per retry, not about two per parked event. A transient failure rejects, and the push queue
   * retries the same probe.
   *
   * The probe is the parked event after the previous retry's probe, wrapping around, starting
   * with the oldest. Parked events of different records are independent, so the trade-off is a
   * refused probe that only its own record cannot write (a true poison) delays the others by a
   * retry; rotating the probe tries each parked record over successive retries, so a
   * writable one is reached within as many retries as there are parked records.
   */
  private async retryParked<N extends CollectionNames<C>>(
    queueKey: string,
    syncAdapter: SyncAdapter<SyncHandlerDataMap<C>, N, TCheckpoint>,
    parked: ChangeBusEvent<SyncHandlerDataMap<C>, N>[],
    pass: PushPass,
  ): Promise<boolean> {
    const previous = parked.findIndex(({ eventId }) => eventId === this.parkedProbes.get(queueKey));
    const probe = parked[(previous + 1) % parked.length]!;
    await this.pushAndAcknowledge(syncAdapter, [probe], pass);
    this.parkedProbes.set(queueKey, probe.eventId as string);
    // An acknowledged event is no longer parked.
    if (this.parkedEvents.has(probe.eventId as string)) return false;
    const others = parked.filter((event) => event !== probe);
    if (others.length > 0) await this.pushAndAcknowledge(syncAdapter, others, pass);
    return true;
  }

  /**
   * Push `events` and acknowledge what the provider accepted. A failure rejects, to be retried,
   * unless it is permanent (`isPermanentPushError`): then the events still pending are pushed
   * again in halves, in outbox order, until each refused event was pushed alone, and those are
   * parked (`parkedEvents`). Later events of a parked record are not pushed past it.
   */
  private async pushAndAcknowledge<N extends CollectionNames<C>>(
    syncAdapter: SyncAdapter<SyncHandlerDataMap<C>, N, TCheckpoint>,
    events: ChangeBusEvent<SyncHandlerDataMap<C>, N>[],
    pass: PushPass,
  ): Promise<void> {
    try {
      await this.pushOnce(syncAdapter, events);
      return;
    } catch (error) {
      if (!isPermanentPushError(error)) throw error;
      if (events.length === 1) {
        this.park(events[0]!, error, pass);
        return;
      }
    }
    // A provider stops at the refused write; what it acknowledged before has left the outbox.
    const remaining = await this.pendingAmong(events);
    const middle = Math.ceil(remaining.length / 2);
    for (const half of [remaining.slice(0, middle), remaining.slice(middle)]) {
      const part = half.filter((event) => !this.isHeld(event));
      if (part.length > 0) await this.pushAndAcknowledge(syncAdapter, part, pass);
    }
  }

  /** Whether another event of the record is parked, so this one must wait behind it. */
  private isHeld(event: ChangeBusEvent<SyncHandlerDataMap<C>>): boolean {
    const recordKey = recordKeyString(this.dirtyRecordKey(event));
    for (const [eventId, parked] of this.parkedEvents) {
      if (parked.recordKey === recordKey && eventId !== event.eventId) return true;
    }
    return false;
  }

  /**
   * Park an event refused on its own, and report it the first time. A handler that lost
   * leadership leaves it to the new leader, which pushes it again.
   */
  private park(event: ChangeBusEvent<SyncHandlerDataMap<C>>, error: unknown, pass: PushPass) {
    if (!this.mayCommit()) return;
    const eventId = event.eventId as string;
    this.parkedEvents.set(eventId, {
      event,
      queueKey: pass.queueKey,
      recordKey: recordKeyString(this.dirtyRecordKey(event)),
    });
    pass.rejections.push(error);
    if (this.reportedRejections.has(eventId)) return;
    this.reportedRejections.add(eventId);
    this.config.onPushRejected?.({
      event,
      error,
      discard: () => this.discardParked(eventId),
    });
  }

  /**
   * Remove a parked event from the outbox (`removeFromOutbox`) and push what its record held
   * back. Does nothing when it is no longer parked here (discarded, pushed, or removed).
   */
  private async discardParked(eventId: string): Promise<void> {
    const parked = this.parkedEvents.get(eventId);
    if (!parked) return;
    if (!(await this.removeFromOutbox([parked.event]))) {
      throw new LeaderChangedError(
        "This context no longer leads the database: the event stays in the outbox.",
      );
    }
    this.requestPush(parked.queueKey);
  }

  private forgetParked(eventId: string): void {
    this.parkedEvents.delete(eventId);
    this.reportedRejections.delete(eventId);
  }

  /** Retry a queue's parked events after a backoff from 5 s, doubling up to 60 s. */
  private scheduleParkedRetry(queueKey: string, signal: AbortSignal): void {
    if (this.parkedRetryTimers.has(queueKey) || signal.aborted) return;
    const delayMs = this.parkedRetryDelays.get(queueKey) ?? 5_000;
    this.parkedRetryDelays.set(queueKey, Math.min(delayMs * 2, 60_000));
    const cancel = () => {
      clearTimeout(timer);
      this.parkedRetryTimers.delete(queueKey);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      this.parkedRetryTimers.delete(queueKey);
      this.retryParkedOnNextPush(queueKey);
      this.requestPush(queueKey);
    }, delayMs);
    this.parkedRetryTimers.set(queueKey, timer);
    signal.addEventListener("abort", cancel, { once: true });
  }

  /**
   * One provider push. Resolves only once every acknowledgement started during the push has
   * finished, awaited by the adapter or not, so the next push reads the outbox after it; a
   * failed one rejects.
   */
  private async pushOnce<N extends CollectionNames<C>>(
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
    signal: AbortSignal,
  ): Promise<void> {
    const queueKey = String(collectionName);
    await this.enqueuePush(
      queueKey,
      async () => {
        const events = await this.collectPendingPushEvents(collectionName);
        return this.pushPending(queueKey, syncAdapter, events, signal);
      },
      signal,
    );
  }

  /** After a successful push, remove the acked events from the outbox (`removeFromOutbox`). */
  protected async ackPushedEvents(events: ChangeBusEvent<SyncHandlerDataMap<C>>[]): Promise<void> {
    await this.removeFromOutbox(events);
  }

  /**
   * Remove pushed events from the local store and refresh dirty tracking, in one transaction:
   * a failure part way leaves the outbox as it was. A record left with no pending writes takes
   * its skipped remote event (`skippedRemoteEvents`) in that transaction, announced like a
   * pulled change once it commits. Resolves false when this handler may no longer write.
   */
  private async removeFromOutbox(
    events: ChangeBusEvent<SyncHandlerDataMap<C>>[],
  ): Promise<boolean> {
    if (!this.mayCommit()) return false;
    const eventIds = events
      .map((event) => event.eventId)
      .filter((eventId): eventId is string => typeof eventId === "string");

    const affectedKeys = new Map<string, DirtyRecordKey>();
    for (const event of events) {
      const key = this.dirtyRecordKey(event);
      affectedKeys.set(recordKeyString(key), key);
    }

    const store = this.config.localChangeStore;
    let applied: Array<[string, ChangeBusEvent<SyncHandlerDataMap<C>>]> = [];
    await this.config.db.transaction(async (tx, { native }) => {
      applied = [];
      if (eventIds.length > 0) await store.deleteEvents(eventIds, native);

      const keysToRemove: DirtyRecordKey[] = [];
      for (const [skippedKey, key] of affectedKeys) {
        const remaining = await store.getPendingEvents(key, native);
        if (remaining.length === 0) {
          keysToRemove.push(key);
          const skipped = this.skippedRemoteEvents.get(skippedKey);
          if (skipped) {
            await this.applyAnyCollectionEvent(skipped, tx);
            applied.push([skippedKey, skipped]);
          }
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

    // Forgotten only once applied: a failed transaction keeps them for the retry.
    for (const [skippedKey] of applied) this.skippedRemoteEvents.delete(skippedKey);
    for (const eventId of eventIds) this.forgetParked(eventId);
    if (applied.length > 0) {
      const changes = applied.map(([, event]) => event);
      this.config.changeBus.publishRemoteBatch(changes);
      this.config.onRemoteChangesCommitted?.(changes);
    }
    return true;
  }

  /** The pushed events still in the outbox, in their order. */
  private async pendingAmong<E extends ChangeBusEvent<SyncHandlerDataMap<C>>>(
    events: E[],
  ): Promise<E[]> {
    const pending = await this.config.localChangeStore.getPendingEvents();
    const pendingIds = new Set(pending.map(({ id }) => id));
    return events.filter((event) => pendingIds.has(event.eventId as string));
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

  private dirtyRecordKey(event: ChangeBusEvent<SyncHandlerDataMap<C>>): DirtyRecordKey {
    const recordId =
      event.type === "delete"
        ? event.id
        : (event.data as Record<string, unknown>)[this.primaryFieldName(event.collection)];
    return { collection: String(event.collection), recordId: String(recordId) };
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

interface ParkedPush<D extends ChangeBusEventDataMapFromCollectionConfigMap<any>> {
  event: ChangeBusEvent<D>;
  queueKey: string;
  recordKey: string;
}

/** One `pushPending` run: its queue and the permanent errors it parked events with. */
interface PushPass {
  queueKey: string;
  rejections: unknown[];
}

function recordKeyString({ collection, recordId }: DirtyRecordKey): string {
  return `${collection}\0${recordId}`;
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
