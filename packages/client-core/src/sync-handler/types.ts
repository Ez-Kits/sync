import type { ChangeBusEvent, ChangeBusEventDataMap } from "../change-bus";

/** Public lifecycle states emitted by a sync client. */
export type SyncStatus = "stopped" | "starting" | "syncing" | "idle" | "offline" | "error";

export interface SyncStatusEvent {
  status: SyncStatus;
  /** Present when status is `error`. */
  error?: unknown;
  changedAt: number;
}

/**
 * App supplied policy for reconciling an incoming remote event with a record that has
 * pending (unpushed) local writes. Records without them always take the remote event.
 * - `"local"`: skip the remote event and keep pushing the local writes. Without a resolver,
 *   this is what every conflict gets.
 * - `"remote"`: apply the remote event and discard the record's pending local writes.
 * - `{ data }`: store `data` locally and push it in place of the pending local writes. After
 *   a remote delete, `data` recreates the record.
 *
 * A throwing resolver fails the pulled batch: the pull stream resubscribes from the last
 * saved checkpoint and the conflict is resolved again.
 *
 * It runs inside the transaction that applies pulled changes, which holds the database
 * until it commits. Decide from `remote` and `local` only: a resolver that queries the
 * database itself (through the adapter, a collection or a live query) waits for that
 * transaction and deadlocks it until the transaction timeout rolls it back.
 */
export type ConflictResolution<
  C extends ChangeBusEventDataMap,
  N extends keyof C = keyof C,
> = (options: {
  remote: ChangeBusEvent<C, N>;
  local: ConflictLocalRecord<C, N> | undefined;
}) => "remote" | "local" | { data: unknown } | Promise<"remote" | "local" | { data: unknown }>;

type ConflictLocalRecord<C extends ChangeBusEventDataMap, N extends keyof C> = C[N] extends {
  record: infer Record;
}
  ? Record
  : C[N]["create"] | C[N]["update"];

/** Turns checkpoints into the strings stored in the database, and back. */
export interface CheckpointSerializer<TCheckpoint> {
  serialize(checkpoint: TCheckpoint): string;
  deserialize(value: string): TCheckpoint;
}

export interface SyncAdapter<
  C extends ChangeBusEventDataMap,
  N extends keyof C = keyof C,
  TCheckpoint = unknown,
> {
  /**
   * The collections this adapter syncs. A client-level adapter is given the outbox events of
   * these only; without the list, of every collection that has no adapter of its own. Writes
   * to a collection no adapter syncs stay local and never enter the outbox.
   */
  readonly collections?: readonly N[];
  /**
   * How this adapter's checkpoints are stored as strings, for checkpoints that are not plain
   * JSON (e.g. a Firestore `Timestamp`). Used for the collections it syncs, unless the client
   * sets its own `checkpointSerializer`; without either, `JSON.stringify` / `JSON.parse`.
   */
  readonly checkpointSerializer?: CheckpointSerializer<TCheckpoint>;
  /** Open a pull stream. A returned cleanup function must stop every listener. */
  pull(options: PullOptions<C, N, TCheckpoint>): void | (() => void) | Promise<void | (() => void)>;
  /**
   * Resolve only after the provider has durably accepted every supplied event. A rejection is
   * retried with backoff, re-sending what is still in the outbox, unless it is permanent: a
   * `PushRejectedError` (or any error with `permanent: true`) for a refusal that sending the
   * same events again would meet as well, such as security rules or validation. Core then
   * pushes the events again in smaller pieces, in order, and parks the ones refused when
   * pushed alone: they stay in the outbox, held with the later events of their record, are
   * retried with a backoff and on every sync start, and are reported through `onPushRejected`.
   * Nothing leaves the outbox unless acknowledged, or discarded by the application.
   */
  push(options: PushOptions<C, N>): void | Promise<void>;
}

/** An event the provider refused when pushed alone; parked in the outbox. */
export interface PushRejection<C extends ChangeBusEventDataMap, N extends keyof C = keyof C> {
  event: ChangeBusEvent<C, N>;
  /** The permanent error the push of this event alone failed with. */
  error: unknown;
  /**
   * Remove the event from the outbox for good, as if acknowledged (dirty records are
   * recomputed, and a remote change pulled for the record meanwhile is applied); the
   * record's later events are then pushed. Resolves without effect once the event is no
   * longer parked (pushed after a retry, already discarded). Rejects with
   * `LeaderChangedError`, leaving the event in the outbox, once this context no longer
   * leads; the new leader pushes it again and reports a new rejection.
   */
  discard: () => Promise<void>;
}

export type PullCheckpointMap<
  C extends ChangeBusEventDataMap,
  N extends keyof C = keyof C,
  TCheckpoint = unknown,
> = Partial<{
  [K in N]: TCheckpoint;
}>;

export interface PullOptions<
  C extends ChangeBusEventDataMap,
  N extends keyof C = keyof C,
  TCheckpoint = unknown,
> {
  /**
   * The checkpoint to use for the pull operation.
   * This is used to resume the pull operation from the last checkpoint.
   * If not provided, the pull operation will start from the beginning.
   */
  checkpoint?: PullCheckpointMap<C, N, TCheckpoint>;

  /**
   * Commit changes to the local database.
   * @param options - The options for the commit operation.
   */
  commitChanges: (options: PullCommitChangesOptions<C, N, TCheckpoint>) => void;
  /** Report provider listener failures so the client can retry the pull stream. */
  onError?: (error: unknown) => void;
  /**
   * The backend's current state of `collections` (default: every collection this stream
   * pulls) was delivered through `commitChanges`, e.g. Firestore's first snapshot that is not
   * from the cache. Call it once per stream. An adapter that cannot tell calls it after its
   * first batch; one that never calls it never reports `caughtUp`. Core applies it once the
   * batches delivered before it have committed.
   */
  onCaughtUp?: (collections?: readonly N[]) => void;
  /**
   * A preview of `collection` (a few rows, fetched first so the app can show them) was
   * delivered with `commitChanges({ preview: true })`. `hasData`: whether the backend
   * returned any row, as the server answered it (not from a cache).
   */
  onPreviewed?: (options: { collection: N; hasData: boolean }) => void;
  /** How many changes this stream's full pull of `collection` delivers, for progress. */
  onCount?: (options: { collection: N; total: number }) => void;
}

export interface PullCommitChangesOptions<
  C extends ChangeBusEventDataMap,
  N extends keyof C = keyof C,
  TCheckpoint = unknown,
> {
  /**
   * The changes to commit to the local database.
   */
  changes: ChangeBusEvent<C, N>[];

  /**
   * New checkpoint to use for the next pull operation.
   */
  checkpoint: PullCheckpointMap<C, N, TCheckpoint>;
  /**
   * The rows of a preview (see `PullOptions.onPreviewed`): applied like any batch but not
   * counted in pull progress, since the full pull delivers them again. Give it no checkpoint.
   */
  preview?: boolean;
}

/** One collection's pull, as `SyncClient.subscribePullState` reports it. */
export interface CollectionPullState {
  /**
   * Local data is good enough to show: the collection was pulled before on this device (it
   * has a checkpoint), its preview committed, or it caught up.
   */
  available: boolean;
  /**
   * Whether the backend has rows for the collection: answered by the preview, by catching
   * up, or `true` when it has a checkpoint. `undefined` until then.
   */
  hasRemoteData: boolean | undefined;
  /** The backend's current state is applied; `false` again whenever the pull restarts or stops. */
  caughtUp: boolean;
  /**
   * Changes the current pull stream committed, and how many it delivers in all when the
   * adapter counted them (`undefined` otherwise). Both restart with the stream.
   */
  progress: { pulled: number; total: number | undefined };
  /** When a pulled batch last committed, or the collection caught up (ms). Not stored. */
  lastPulledAt: number | undefined;
}

/** What a sync handler reports about one collection's pull. */
export type PullStateEvent =
  | { type: "started" }
  | { type: "stopped" }
  | { type: "committed"; count: number; at: number }
  | { type: "previewed"; hasData: boolean }
  | { type: "count"; total: number }
  | { type: "caughtUp"; at: number };

export interface PushOptions<C extends ChangeBusEventDataMap, N extends keyof C = keyof C> {
  /**
   * The events to push to the remote server.
   */
  events: ChangeBusEvent<C, N>[];

  /**
   * Acknowledge events the provider durably accepted, removing them from the outbox. Await
   * it before `push` resolves: the next push reads the outbox once it has finished. The
   * handler also waits for one that is not awaited, and a rejection fails the push, which is
   * retried (re-sending events still in the outbox).
   * @param options - The options for the commit operation.
   */
  commitChanges: (options: PushCommitChangesOptions<C, N>) => Promise<void>;
}

export interface PushCommitChangesOptions<
  C extends ChangeBusEventDataMap,
  N extends keyof C = keyof C,
> {
  /**
   * The events to commit after successful sync.
   */
  events: ChangeBusEvent<C, N>[];
}
