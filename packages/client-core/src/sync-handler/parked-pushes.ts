import type { ChangeBusEvent, ChangeBusEventDataMapFromCollectionConfigMap } from "../change-bus";

type DataMap = ChangeBusEventDataMapFromCollectionConfigMap<any>;

export interface ParkedPush<D extends DataMap> {
  event: ChangeBusEvent<D>;
  queueKey: string;
  recordKey: string;
}

/**
 * Pending events the provider refused on their own, by event id. A parked event stays in the
 * outbox and is left out of pushes, with every later event of its record, so the record's
 * order holds while other records keep syncing. Parked events are retried after a backoff
 * and whenever sync starts; they leave the outbox only when acknowledged or discarded.
 *
 * Kept in memory: a reload or a new leader pushes them again, which is safe, since nothing
 * was written for them.
 */
export class ParkedPushes<D extends DataMap> {
  private events = new Map<string, ParkedPush<D>>();
  /** Parked event ids `onPushRejected` was called for, so a retry is not reported again. */
  private reported = new Set<string>();
  /** Queues whose next push starts with their parked events. */
  private retryDue = new Set<string>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private retryDelays = new Map<string, number>();
  /** Per queue, the event id of the last retry's probe (see `BaseSyncHandler.retryParked`). */
  private probes = new Map<string, string>();

  /** @param requestPush schedules a push of a queue whose parked events are due. */
  constructor(private readonly requestPush: (queueKey: string) => void) {}

  ids(): string[] {
    return [...this.events.keys()];
  }

  has(eventId: string): boolean {
    return this.events.has(eventId);
  }

  get(eventId: string): ParkedPush<D> | undefined {
    return this.events.get(eventId);
  }

  add(eventId: string, parked: ParkedPush<D>): void {
    this.events.set(eventId, parked);
  }

  wasReported(eventId: string): boolean {
    return this.reported.has(eventId);
  }

  markReported(eventId: string): void {
    this.reported.add(eventId);
  }

  forget(eventId: string): void {
    this.events.delete(eventId);
    this.reported.delete(eventId);
  }

  /** Forget a queue's events that left the outbox; resolves whether any did. */
  forgetAbsent(queueKey: string, pendingIds: ReadonlySet<unknown>): boolean {
    const before = this.events.size;
    for (const [eventId, parked] of this.events) {
      if (parked.queueKey === queueKey && !pendingIds.has(eventId)) this.forget(eventId);
    }
    return this.events.size !== before;
  }

  forgetRecords(recordKeys: ReadonlySet<string>): void {
    for (const [eventId, parked] of this.events) {
      if (recordKeys.has(parked.recordKey)) this.forget(eventId);
    }
  }

  /** Whether another event of the record is parked, so `eventId` must wait behind it. */
  isHeld(recordKey: string, eventId: unknown): boolean {
    for (const [parkedId, parked] of this.events) {
      if (parked.recordKey === recordKey && parkedId !== eventId) return true;
    }
    return false;
  }

  hasQueue(queueKey: string): boolean {
    return [...this.events.values()].some((entry) => entry.queueKey === queueKey);
  }

  retryOnNextPush(queueKey: string): void {
    this.retryDue.add(queueKey);
  }

  isRetryDue(queueKey: string): boolean {
    return this.retryDue.has(queueKey);
  }

  clearRetryDue(queueKey: string): void {
    this.retryDue.delete(queueKey);
  }

  lastProbe(queueKey: string): string | undefined {
    return this.probes.get(queueKey);
  }

  setLastProbe(queueKey: string, eventId: string): void {
    this.probes.set(queueKey, eventId);
  }

  /** A queue has nothing parked any more: its next rejection starts a fresh backoff. */
  resetRetries(queueKey: string): void {
    this.retryDelays.delete(queueKey);
    this.probes.delete(queueKey);
  }

  /** Retry a queue's parked events after a backoff from 5 s, doubling up to 60 s. */
  scheduleRetry(queueKey: string, signal: AbortSignal): void {
    if (this.retryTimers.has(queueKey) || signal.aborted) return;
    const delayMs = this.retryDelays.get(queueKey) ?? 5_000;
    this.retryDelays.set(queueKey, Math.min(delayMs * 2, 60_000));
    const cancel = () => {
      clearTimeout(timer);
      this.retryTimers.delete(queueKey);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      this.retryTimers.delete(queueKey);
      this.retryOnNextPush(queueKey);
      this.requestPush(queueKey);
    }, delayMs);
    this.retryTimers.set(queueKey, timer);
    signal.addEventListener("abort", cancel, { once: true });
  }
}
