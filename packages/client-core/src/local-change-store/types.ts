export type DirtyRecordState = "dirty" | "deleted";

export interface StoredChangeBusEvent {
  id: string;
  type: "create" | "update" | "delete";
  collection: string;
  /** Create/update payload; null for deletes. */
  data: unknown;
  /** Stringified primary key for indexing and dirty tracking. */
  recordId: string;
  createdAt: number;
}

export interface DirtyRecord {
  collection: string;
  recordId: string;
  state: DirtyRecordState;
  updatedAt: number;
}

export interface DirtyRecordKey {
  collection: string;
  recordId: string;
}

/**
 * The latest pulled event of a record that was skipped because the record had pending local
 * writes; applied by the acknowledgement that leaves the record with none.
 */
export interface SkippedRemoteEvent {
  collection: string;
  recordId: string;
  /** The pulled change event, as JSON-compatible data (stored like outbox event data). */
  event: unknown;
}

/** What a local-change read covers: a collection by name, or one record of a collection. */
export type LocalChangeScope = string | DirtyRecordKey;

/**
 * How long a store keeps the record that an event was applied, counted from its
 * `createdAt` to the newest appended event's. Far longer than a commit retry can take.
 */
export const APPLIED_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * The outbox, dirty records and the sync state that must survive with them: pull
 * checkpoints and skipped remote events. Every method takes an optional
 * `transactionContext`: the `native` handle of a `DBAdapterTransactionContext`. With it the
 * call runs in that transaction; without it, on its own, after any open transaction ends.
 */
export interface ILocalChangeStore<TTransactionContext = unknown> {
  /**
   * Create the storage of every method when it is missing, and upgrade it when an
   * older version of the library created it. The sync client calls it once the DB storage is
   * ready and before any read, write or sync, in every context, so it must be idempotent and
   * safe to run concurrently. Applications never run these migrations themselves.
   */
  initialize(): Promise<void>;
  /**
   * Events get a database-assigned position, so they are read back in commit order. Each
   * event's `id` is also recorded as applied, in the same transaction, and outlives its
   * acknowledgement; records older than {@link APPLIED_EVENT_RETENTION_MS} are pruned here.
   */
  appendEvents(
    events: StoredChangeBusEvent[],
    transactionContext?: TTransactionContext,
  ): Promise<void>;
  /** Whether an event with this `id` was appended, even if it was acknowledged since. */
  hasAppliedEvent(eventId: string, transactionContext?: TTransactionContext): Promise<boolean>;
  /** Events not yet acknowledged by the provider, in the order they were committed. */
  getPendingEvents(
    scope?: LocalChangeScope,
    transactionContext?: TTransactionContext,
  ): Promise<StoredChangeBusEvent[]>;
  deleteEvents(ids: string[], transactionContext?: TTransactionContext): Promise<void>;
  upsertDirtyRecord(record: DirtyRecord, transactionContext?: TTransactionContext): Promise<void>;
  removeDirtyRecords(
    keys: DirtyRecordKey[],
    transactionContext?: TTransactionContext,
  ): Promise<void>;
  getDirtyRecords(
    scope?: LocalChangeScope,
    transactionContext?: TTransactionContext,
  ): Promise<DirtyRecord[]>;
  /** A collection's serialized pull checkpoint (see `createDBCheckpointStorage`). */
  getCheckpoint(
    collection: string,
    transactionContext?: TTransactionContext,
  ): Promise<string | undefined>;
  /** Replace a collection's serialized checkpoint; `undefined` removes it. */
  saveCheckpoint(
    collection: string,
    value: string | undefined,
    transactionContext?: TTransactionContext,
  ): Promise<void>;
  getSkippedRemoteEvents(
    scope?: LocalChangeScope,
    transactionContext?: TTransactionContext,
  ): Promise<SkippedRemoteEvent[]>;
  /** Insert or replace the skipped remote event of `entry`'s record. */
  upsertSkippedRemoteEvent(
    entry: SkippedRemoteEvent,
    transactionContext?: TTransactionContext,
  ): Promise<void>;
  removeSkippedRemoteEvents(
    keys: DirtyRecordKey[],
    transactionContext?: TTransactionContext,
  ): Promise<void>;
}

export interface AtomicLocalChangeStore<
  TTransactionContext = unknown,
> extends ILocalChangeStore<TTransactionContext> {
  readonly atomicLocalMutationCapability: "atomic";
}
