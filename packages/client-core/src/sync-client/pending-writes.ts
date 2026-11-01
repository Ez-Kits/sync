import type { PendingEventKey } from "../local-change-store";

/** Outbox events not yet confirmed by the backend (see `SyncClient.getPendingWrites`). */
export interface PendingWrites<TCollectionName extends string = string> {
  /** Pending outbox events, parked ones included. Two writes to one record count twice. */
  total: number;
  /** Of those, how many are parked after a permanent refusal (`onPushRejected`). */
  rejected: number;
  /** `total` per collection; collections with nothing pending are left out. */
  byCollection: Partial<Record<TCollectionName, number>>;
}

export interface WaitForPushedOptions {
  /** Reject with a `WaitForPushedError` (`reason: "timeout"`) after this long. Default: never. */
  timeoutMs?: number;
}

/** Why `waitForPushed` gave up, with the last pending writes it read. */
export class WaitForPushedError extends Error {
  override readonly name = "WaitForPushedError";

  constructor(
    readonly reason: "timeout" | "offline" | "disposed",
    readonly pending: PendingWrites | undefined,
  ) {
    super(
      reason === "timeout"
        ? "Timed out waiting for the outbox to be pushed."
        : reason === "offline"
          ? "Offline: the outbox cannot be pushed."
          : "The sync client was disposed.",
    );
  }
}

export function summarizePendingWrites(
  keys: readonly PendingEventKey[],
  parked: ReadonlySet<string>,
): PendingWrites {
  const byCollection: Record<string, number> = {};
  let rejected = 0;
  for (const { id, collection } of keys) {
    byCollection[collection] = (byCollection[collection] ?? 0) + 1;
    if (parked.has(id)) rejected += 1;
  }
  return { total: keys.length, rejected, byCollection };
}

const sameValue = (a: PendingWrites, b: PendingWrites) =>
  a.total === b.total &&
  a.rejected === b.rejected &&
  Object.keys(a.byCollection).length === Object.keys(b.byCollection).length &&
  Object.entries(a.byCollection).every(([name, count]) => b.byCollection[name] === count);

/**
 * Counts the outbox for every observer. Reads only while observed; `refresh` calls that
 * arrive during a read are coalesced into one more read, so a bulk write does not queue one
 * outbox read per row.
 */
export class PendingWritesTracker {
  /** Ids the leader reported parked; its own handler's when this context leads. */
  private parked = new Set<string>();
  /** Each observer, with the value it last received. */
  private listeners = new Map<(pending: PendingWrites) => void, PendingWrites | undefined>();
  private reading = false;
  private stale = false;

  constructor(private readonly readKeys: () => Promise<PendingEventKey[]>) {}

  async read(): Promise<PendingWrites> {
    return summarizePendingWrites(await this.readKeys(), this.parked);
  }

  setParked(ids: Iterable<string>): void {
    this.parked = new Set(ids);
    this.refresh();
  }

  /** Called with the current value once read, then whenever it changes. */
  subscribe(listener: (pending: PendingWrites) => void): () => void {
    this.listeners.set(listener, undefined);
    this.refresh();
    return () => this.listeners.delete(listener);
  }

  refresh(): void {
    if (this.listeners.size === 0) return;
    if (this.reading) {
      this.stale = true;
      return;
    }
    this.reading = true;
    void (async () => {
      try {
        do {
          this.stale = false;
          this.emit(await this.read());
        } while (this.stale);
      } catch {
        // A failed read (e.g. the leader changed) is retried by the next change or invalidation.
      } finally {
        this.reading = false;
      }
    })();
  }

  close(): void {
    this.listeners.clear();
  }

  private emit(pending: PendingWrites): void {
    for (const [listener, last] of this.listeners) {
      if (last && sameValue(last, pending)) continue;
      this.listeners.set(listener, pending);
      try {
        listener(pending);
      } catch {
        // One observer must not block delivery to other observers.
      }
    }
  }
}
