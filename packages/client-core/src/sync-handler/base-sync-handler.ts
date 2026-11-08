import type {
  ChangeBus,
  ChangeBusEvent,
  ChangeBusEventDataMapFromCollectionConfigMap,
} from "../change-bus";
import type { CheckpointStorage } from "../checkpoint-storage";
import type { CollectionConfigMap, CollectionNames, ConfigForName } from "../collection";
import { primaryKeyOf, recordIdOf } from "../collection/primary-key";
import type {
  BaseDBAdapter,
  DBAdapterOperations,
  DBAdapterTransactionContext,
} from "../db-adapter";
import { LeaderChangedError } from "../db-storage/errors";
import type { RecordKey, ILocalChangeStore } from "../local-change-store";
import { isPermanentPushError, PushConflictError } from "./errors";
import { ParkedPushes } from "./parked-pushes";
import { retryPull, type PullStream, type PullSubscribe } from "./pull-retry";
import { recordKeyString, toPushEvent } from "./record-events";
import {
  reconcileRemoteEvent,
  type ReconciledRemoteEvent,
  type RemoteEventReconciliation,
} from "./remote-event-reconciliation";
import type { ConflictResolution, PullStateEvent, PushRejection, SyncAdapter } from "./types";

/**
 * Changes applied per pull transaction. A larger batch commits in chunks with a pause between
 * them, so local writes and the page are not held up for the whole batch.
 */
export const PULL_COMMIT_CHUNK_SIZE = 200;

export type { PullStream } from "./pull-retry";

const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export type SyncHandlerDataMap<C extends CollectionConfigMap> =
  ChangeBusEventDataMapFromCollectionConfigMap<C>;

export interface BaseSyncHandlerConfig<
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> {
  collections: C;
  db: DB;
  changeBus: ChangeBus<SyncHandlerDataMap<C>>;
  /** Checkpoints kept in `localChangeStore`; each pulled one is saved in its pull transaction. */
  checkpointStorage: CheckpointStorage<CollectionNames<C>, TCheckpoint>;
  localChangeStore: ILocalChangeStore;
  onSyncError?: (error: unknown) => void;
  onSyncSuccess?: () => void;
  /** Decides remote changes to records with pending local writes; without it they stay local. */
  resolveConflict?: ConflictResolution<SyncHandlerDataMap<C>>;
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
  /** Called after this handler removed events from the outbox, or parked new ones. */
  onOutboxChanged?: () => void;
  /** Progress of a collection's pull (see `CollectionPullState`). */
  onPullState?: (collection: string, event: PullStateEvent) => void;
}

export abstract class BaseSyncHandler<
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> {
  protected readonly collectionMap: Map<CollectionNames<C>, C[number]>;
  private pushQueues = new Map<string, Promise<void>>();
  private parked = new ParkedPushes<SyncHandlerDataMap<C>>((queueKey) =>
    this.requestPush(queueKey),
  );
  private reconciliation: RemoteEventReconciliation<C>;

  constructor(protected readonly config: BaseSyncHandlerConfig<C, DB, TCheckpoint>) {
    this.collectionMap = new Map(
      config.collections.map((collection) => [collection.name, collection]),
    );
    this.reconciliation = {
      store: config.localChangeStore,
      resolveConflict: config.resolveConflict,
      recordKeyOf: (event) => this.eventRecordKey(event),
      primaryKeyOf: (event) => this.eventKey(event),
      hasCompositeKey: (collection) => Array.isArray(this.keyConfig(collection).primaryField),
    };
  }

  /**
   * Schedule a push of the queue's pending events (`pushPending`); called when its parked
   * events are due or a discard released a record.
   */
  protected abstract requestPush(queueKey: string): void;

  /** Ids of the events parked here (see {@link ParkedPushes}). */
  parkedEventIds(): string[] {
    return this.parked.ids();
  }

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

  /** Keep a pull listener alive across provider errors (see {@link retryPull}). */
  protected retryPull(subscribe: PullSubscribe): () => void {
    return retryPull(this.config, subscribe);
  }

  /**
   * Report a new pull stream of `collections` and build its readiness callbacks. Each signal
   * waits in `enqueue` (the stream's commit queue) behind the batches delivered before it, and
   * is dropped once the stream is no longer active. The returned `onError` also reports the
   * collections as stopped.
   */
  protected pullSignals<N extends CollectionNames<C>>(
    collections: readonly N[],
    stream: PullStream,
    enqueue: (task: () => void) => void,
  ) {
    const report = (names: readonly N[], event: PullStateEvent) => {
      for (const name of names) this.config.onPullState?.(String(name), event);
    };
    const queued = (task: () => void) =>
      enqueue(() => {
        if (this.mayCommit() && stream.isActive()) task();
      });
    report(collections, { type: "started" });
    return {
      onError: (error: unknown) => {
        if (stream.isActive()) report(collections, { type: "stopped" });
        stream.onError(error);
      },
      onCaughtUp: (names?: readonly N[]) =>
        queued(() => report(names ?? collections, { type: "caughtUp", at: Date.now() })),
      onPreviewed: ({ collection, hasData }: { collection: N; hasData: boolean }) =>
        queued(() => report([collection], { type: "previewed", hasData })),
      onCount: ({ collection, total }: { collection: N; total: number }) =>
        queued(() => report([collection], { type: "count", total })),
    };
  }

  /** Report the pull of `collections` stopped. */
  protected reportPullStopped(collections: readonly CollectionNames<C>[]): void {
    for (const name of collections) this.config.onPullState?.(String(name), { type: "stopped" });
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
   * Apply one pulled batch and save its checkpoint (a batch without changes still opens a
   * transaction, for its checkpoint), then announce what it applied. A batch of more than
   * {@link PULL_COMMIT_CHUNK_SIZE} changes commits in chunks, each in its own transaction and
   * announced when it commits, yielding to the event loop between them; only the last saves
   * the checkpoint, so a batch cut short is pulled and applied again (pulled rows are
   * upserted). It stops between chunks once `isActive` turns false or this handler may no
   * longer write. Resolves `true` when conflict resolution queued an outbox event to push.
   */
  protected async commitPulledChanges(
    changes: ChangeBusEvent<SyncHandlerDataMap<C>>[],
    checkpoint: Partial<Record<CollectionNames<C>, TCheckpoint>>,
    apply: (
      event: ChangeBusEvent<SyncHandlerDataMap<C>>,
      tx: DBAdapterOperations<C>,
    ) => Promise<void>,
    options: { isActive?: () => boolean; preview?: boolean } = {},
  ): Promise<boolean> {
    let needsPush = false;
    for (let offset = 0; ; offset += PULL_COMMIT_CHUNK_SIZE) {
      const chunk = changes.slice(offset, offset + PULL_COMMIT_CHUNK_SIZE);
      const last = offset + PULL_COMMIT_CHUNK_SIZE >= changes.length;
      needsPush =
        (await this.commitPulledChunk(chunk, last ? checkpoint : {}, apply, options)) || needsPush;
      if (last) break;
      await yieldToEventLoop();
      if (!this.mayCommit() || options.isActive?.() === false) return needsPush;
    }
    this.config.onSyncSuccess?.();
    return needsPush;
  }

  private async commitPulledChunk(
    changes: ChangeBusEvent<SyncHandlerDataMap<C>>[],
    checkpoint: Partial<Record<CollectionNames<C>, TCheckpoint>>,
    apply: (
      event: ChangeBusEvent<SyncHandlerDataMap<C>>,
      tx: DBAdapterOperations<C>,
    ) => Promise<void>,
    options: { preview?: boolean },
  ): Promise<boolean> {
    let applied: ChangeBusEvent<SyncHandlerDataMap<C>>[] = [];
    let needsPush = false;
    await this.config.db.transaction(async (tx, context) => {
      applied = [];
      needsPush = false;
      const skipped = await this.config.localChangeStore.getSkippedRemoteEvents(
        undefined,
        context.native,
      );
      const skippedKeys = new Set(skipped.map(recordKeyString));
      for (const event of changes) {
        const resolved = await this.resolveRemoteEvent(event, context, skippedKeys);
        needsPush ||= resolved.needsPush;
        if (!resolved.event) continue;
        await apply(resolved.event, tx);
        applied.push(resolved.event);
      }
      await this.saveCheckpointMap(checkpoint, context.native);
    });

    this.config.changeBus.publishRemoteBatch(applied);
    if (applied.length > 0) this.config.onRemoteChangesCommitted?.(applied);
    const counts = new Map<string, number>(Object.keys(checkpoint).map((name) => [name, 0]));
    for (const { collection } of changes) {
      const name = String(collection);
      counts.set(name, (counts.get(name) ?? 0) + (options.preview ? 0 : 1));
    }
    const at = Date.now();
    for (const [name, count] of counts) {
      this.config.onPullState?.(name, { type: "committed", count, at });
    }
    return needsPush;
  }

  /** Reconcile a pulled or refused event with the record's pending writes (see {@link reconcileRemoteEvent}). */
  protected resolveRemoteEvent(
    event: ChangeBusEvent<SyncHandlerDataMap<C>>,
    context: DBAdapterTransactionContext<C>,
    skippedKeys?: Set<string>,
    pushConflict = false,
  ): Promise<ReconciledRemoteEvent<C>> {
    return reconcileRemoteEvent(this.reconciliation, event, context, skippedKeys, pushConflict);
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
    return storedEvents.map(toPushEvent) as ChangeBusEvent<SyncHandlerDataMap<C>, N>[];
  }

  /** The collections' pending events in commit order, across collections, as one transaction wrote them. */
  protected async collectAllPendingPushEvents(
    collectionNames: readonly CollectionNames<C>[],
  ): Promise<ChangeBusEvent<SyncHandlerDataMap<C>>[]> {
    const names = new Set(collectionNames.map(String));
    const storedEvents = await this.config.localChangeStore.getPendingEvents();
    return storedEvents
      .filter((stored) => names.has(stored.collection))
      .map(toPushEvent) as ChangeBusEvent<SyncHandlerDataMap<C>>[];
  }

  /** Push the queue's parked events, and the queue's next push, first (see {@link ParkedPushes}). */
  protected retryParkedOnNextPush(queueKey: string): void {
    this.parked.retryOnNextPush(queueKey);
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
    if (this.parked.forgetAbsent(queueKey, pendingIds)) this.config.onOutboxChanged?.();

    const pass: PushPass = { queueKey, rejections: [] };
    let toPush = events;
    if (this.parked.isRetryDue(queueKey)) {
      const parked = events.filter(({ eventId }) => this.parked.has(eventId as string));
      if (parked.length > 0 && (await this.retryParked(queueKey, syncAdapter, parked, pass))) {
        toPush = await this.pendingAmong(events);
      }
      this.parked.clearRetryDue(queueKey);
    }
    toPush = toPush.filter(
      (event) => !this.parked.has(event.eventId as string) && !this.isHeld(event),
    );
    if (toPush.length > 0) await this.pushAndAcknowledge(syncAdapter, toPush, pass);

    if (pass.rejections.length > 0) this.config.onSyncError?.(pass.rejections.at(-1));
    const parked = this.parked.hasQueue(queueKey);
    if (parked) this.parked.scheduleRetry(queueKey, signal);
    else this.parked.resetRetries(queueKey);
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
    const previous = parked.findIndex(({ eventId }) => eventId === this.parked.lastProbe(queueKey));
    const probe = parked[(previous + 1) % parked.length]!;
    await this.pushAndAcknowledge(syncAdapter, [probe], pass);
    this.parked.setLastProbe(queueKey, probe.eventId as string);
    // An acknowledged event is no longer parked.
    if (this.parked.has(probe.eventId as string)) return false;
    const others = parked.filter((event) => event !== probe);
    if (others.length > 0) await this.pushAndAcknowledge(syncAdapter, others, pass);
    return true;
  }

  /**
   * Push `events` and acknowledge what the provider accepted. A failure rejects, to be retried,
   * unless it is permanent (`isPermanentPushError`): then the events still pending are pushed
   * again in halves, in outbox order, until each refused event was pushed alone, and those are
   * parked ({@link ParkedPushes}). Later events of a parked record are not pushed past it. Resolves
   * false after a conflict: the rest of a split waits for the push the decision requested, as
   * pushing it now could send a discarded write, or a record's later write before its earlier.
   */
  private async pushAndAcknowledge<N extends CollectionNames<C>>(
    syncAdapter: SyncAdapter<SyncHandlerDataMap<C>, N, TCheckpoint>,
    events: ChangeBusEvent<SyncHandlerDataMap<C>, N>[],
    pass: PushPass,
  ): Promise<boolean> {
    try {
      await this.pushOnce(syncAdapter, events);
      return true;
    } catch (error) {
      if (error instanceof PushConflictError) {
        await this.resolvePushConflict(error, pass);
        return false;
      }
      if (!isPermanentPushError(error)) throw error;
      if (events.length === 1) {
        this.park(events[0]!, error, pass);
        return true;
      }
    }
    // A provider stops at the refused write; what it acknowledged before has left the outbox.
    const remaining = await this.pendingAmong(events);
    const middle = Math.ceil(remaining.length / 2);
    for (const half of [remaining.slice(0, middle), remaining.slice(middle)]) {
      // A pulled conflict's decision may have replaced events since they were read.
      const part = (await this.pendingAmong(half)).filter((event) => !this.isHeld(event));
      if (part.length > 0 && !(await this.pushAndAcknowledge(syncAdapter, part, pass))) {
        return false;
      }
    }
    return true;
  }

  /**
   * Decide a refused push's server state like pulled conflicts, in one transaction, and push the
   * outbox again, numbered from the revisions just stored. Events of these records parked
   * earlier go with it: they were refused for what has now been resolved, or are retried anyway.
   */
  private async resolvePushConflict(conflict: PushConflictError, pass: PushPass): Promise<void> {
    if (!this.mayCommit()) return;
    let applied: ChangeBusEvent<SyncHandlerDataMap<C>>[] = [];
    await this.config.db.transaction(async (tx, context) => {
      applied = [];
      for (const event of conflict.events) {
        const resolved = await this.resolveRemoteEvent(event, context, undefined, true);
        if (!resolved.event) continue;
        await this.applyAnyCollectionEvent(resolved.event, tx);
        applied.push(resolved.event);
      }
    });
    const resolvedKeys = new Set(
      conflict.events.map((event) => recordKeyString(this.eventRecordKey(event))),
    );
    this.parked.forgetRecords(resolvedKeys);
    this.config.onOutboxChanged?.();
    if (applied.length > 0) {
      this.config.changeBus.publishRemoteBatch(applied);
      this.config.onRemoteChangesCommitted?.(applied);
    }
    this.requestPush(pass.queueKey);
  }

  /** Whether another event of the record is parked, so this one must wait behind it. */
  private isHeld(event: ChangeBusEvent<SyncHandlerDataMap<C>>): boolean {
    return this.parked.isHeld(recordKeyString(this.eventRecordKey(event)), event.eventId);
  }

  /**
   * Park an event refused on its own, and report it the first time. A handler that lost
   * leadership leaves it to the new leader, which pushes it again.
   */
  private park(event: ChangeBusEvent<SyncHandlerDataMap<C>>, error: unknown, pass: PushPass) {
    if (!this.mayCommit()) return;
    const eventId = event.eventId as string;
    this.parked.add(eventId, {
      event,
      queueKey: pass.queueKey,
      recordKey: recordKeyString(this.eventRecordKey(event)),
    });
    pass.rejections.push(error);
    if (this.parked.wasReported(eventId)) return;
    this.config.onOutboxChanged?.();
    this.parked.markReported(eventId);
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
    const parked = this.parked.get(eventId);
    if (!parked) return;
    if (!(await this.removeFromOutbox([parked.event]))) {
      throw new LeaderChangedError(
        "This context no longer leads the database: the event stays in the outbox.",
      );
    }
    this.requestPush(parked.queueKey);
  }

  /**
   * The events with the `rev` to write, on the adapter's `revisionedCollections`: each record's
   * in outbox order, from its stored revision + 1. Pushed events are numbered per attempt, so a
   * refused one is parked (and reported) without a `rev`, as it was never written.
   */
  private async numberEvents<N extends CollectionNames<C>>(
    syncAdapter: SyncAdapter<SyncHandlerDataMap<C>, N, TCheckpoint>,
    events: ChangeBusEvent<SyncHandlerDataMap<C>, N>[],
  ): Promise<ChangeBusEvent<SyncHandlerDataMap<C>, N>[]> {
    const revisioned = new Set<PropertyKey>(syncAdapter.revisionedCollections);
    if (revisioned.size === 0) return events;
    const lastRevs = new Map<string, number>();
    const numbered: ChangeBusEvent<SyncHandlerDataMap<C>, N>[] = [];
    for (const event of events) {
      if (!revisioned.has(event.collection)) {
        numbered.push(event);
        continue;
      }
      const key = this.eventRecordKey(event);
      const recordKey = recordKeyString(key);
      const rev =
        (lastRevs.get(recordKey) ?? (await this.config.localChangeStore.getRevision(key)) ?? 0) + 1;
      lastRevs.set(recordKey, rev);
      numbered.push({ ...event, rev });
    }
    return numbered;
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
    const numbered = await this.numberEvents(syncAdapter, events);
    try {
      await syncAdapter.push({
        events: numbered,
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
   * Remove pushed events from the local store, in one transaction:
   * a failure part way leaves the outbox as it was. A record left with no pending writes takes
   * its stored skipped remote event (see `resolveRemoteEvent`) in that transaction, which also
   * removes it, announced like a pulled change once it commits. Resolves false when this
   * handler may no longer write.
   *
   * An acknowledged `rev` raises the record's stored revision (a conflict decided meanwhile may
   * have stored a higher one). A skipped event with a `rev` is applied only above the stored
   * revision: otherwise it is a stale echo, and is only removed.
   */
  private async removeFromOutbox(
    events: ChangeBusEvent<SyncHandlerDataMap<C>>[],
  ): Promise<boolean> {
    if (!this.mayCommit()) return false;
    const eventIds = events
      .map((event) => event.eventId)
      .filter((eventId): eventId is string => typeof eventId === "string");

    const affectedKeys = new Map<string, RecordKey>();
    const acknowledgedRevs = new Map<string, number>();
    for (const event of events) {
      const key = this.eventRecordKey(event);
      const recordKey = recordKeyString(key);
      affectedKeys.set(recordKey, key);
      if (event.rev !== undefined) acknowledgedRevs.set(recordKey, event.rev);
    }

    const store = this.config.localChangeStore;
    let applied: ChangeBusEvent<SyncHandlerDataMap<C>>[] = [];
    await this.config.db.transaction(async (tx, { native }) => {
      applied = [];
      if (eventIds.length > 0) await store.deleteEvents(eventIds, native);

      const storedRevOf = async (key: RecordKey) => (await store.getRevision(key, native)) ?? 0;
      const settledKeys: RecordKey[] = [];
      // Read once, when a record is left with no pending writes.
      let skippedEvents: Map<string, unknown> | undefined;
      for (const [recordKey, key] of affectedKeys) {
        const acknowledgedRev = acknowledgedRevs.get(recordKey);
        if (acknowledgedRev !== undefined && acknowledgedRev > (await storedRevOf(key))) {
          await store.upsertRevision({ ...key, rev: acknowledgedRev }, native);
        }
        const remaining = await store.getPendingEvents(key, native);
        if (remaining.length > 0) continue;
        skippedEvents ??= new Map(
          (await store.getSkippedRemoteEvents(undefined, native)).map((entry) => [
            recordKeyString(entry),
            entry.event,
          ]),
        );
        const skipped = skippedEvents.get(recordKey) as
          | ChangeBusEvent<SyncHandlerDataMap<C>>
          | undefined;
        if (skipped) {
          settledKeys.push(key);
          const { rev } = skipped;
          if (rev !== undefined && rev <= (await storedRevOf(key))) continue;
          await this.applyAnyCollectionEvent(skipped, tx);
          applied.push(skipped);
          if (rev !== undefined) await store.upsertRevision({ ...key, rev }, native);
        }
      }

      // Removed with the acknowledgement: a failed transaction keeps them for the retry.
      if (settledKeys.length > 0) await store.removeSkippedRemoteEvents(settledKeys, native);
    });

    for (const eventId of eventIds) this.parked.forget(eventId);
    this.config.onOutboxChanged?.();
    if (applied.length > 0) {
      this.config.changeBus.publishRemoteBatch(applied);
      this.config.onRemoteChangesCommitted?.(applied);
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

  /** Save each defined checkpoint in the given pull transaction. */
  protected async saveCheckpointMap(
    checkpointMap: Partial<Record<CollectionNames<C>, TCheckpoint>>,
    transactionContext: unknown,
  ): Promise<void> {
    for (const collection of this.config.collections) {
      const collectionName = collection.name as CollectionNames<C>;
      const checkpoint = checkpointMap[collectionName];
      if (checkpoint === undefined) continue;
      await this.config.checkpointStorage.saveCheckpoint(
        collectionName,
        checkpoint,
        transactionContext,
      );
    }
  }

  private eventRecordKey(event: ChangeBusEvent<SyncHandlerDataMap<C>>): RecordKey {
    const recordId = recordIdOf(this.keyConfig(event.collection), this.eventKey(event));
    return { collection: String(event.collection), recordId };
  }

  /** The primary key of the record an event changes. */
  private eventKey(event: ChangeBusEvent<SyncHandlerDataMap<C>>): unknown {
    if (event.type === "delete") return event.id;
    return primaryKeyOf(this.keyConfig(event.collection), event.data as Record<string, unknown>);
  }

  private keyConfig(
    collectionName: keyof SyncHandlerDataMap<C>,
  ): Pick<C[number], "name" | "primaryField"> {
    const collectionConfig = this.collectionMap.get(collectionName as CollectionNames<C>);
    return { name: String(collectionName), primaryField: collectionConfig?.primaryField ?? "id" };
  }

  private async upsertRow<N extends CollectionNames<C>>(
    collectionName: N,
    collectionConfig: ConfigForName<C, N>,
    row: Record<string, unknown>,
    db: DBAdapterOperations<C>,
  ): Promise<void> {
    const id = primaryKeyOf(collectionConfig, row);
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

/** One `pushPending` run: its queue and the permanent errors it parked events with. */
interface PushPass {
  queueKey: string;
  rejections: unknown[];
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
