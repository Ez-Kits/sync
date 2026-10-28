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

/** What a local-change read covers: a collection by name, or one record of a collection. */
export type LocalChangeScope = string | DirtyRecordKey;

/**
 * The outbox and dirty records. Every method takes an optional `transactionContext`: the
 * `native` handle of a `DBAdapterTransactionContext`. With it the call runs in that
 * transaction; without it, on its own, after any open transaction ends.
 */
export interface ILocalChangeStore<TTransactionContext = unknown> {
  /**
   * Create the outbox and dirty-record storage when it is missing, and upgrade it when an
   * older version of the library created it. The sync client calls it once the DB storage is
   * ready and before any read, write or sync, in every context, so it must be idempotent and
   * safe to run concurrently. Applications never run these migrations themselves.
   */
  initialize(): Promise<void>;
  /** Events get a database-assigned position, so they are read back in commit order. */
  appendEvents(
    events: StoredChangeBusEvent[],
    transactionContext?: TTransactionContext,
  ): Promise<void>;
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
}

export interface AtomicLocalChangeStore<
  TTransactionContext = unknown,
> extends ILocalChangeStore<TTransactionContext> {
  readonly atomicLocalMutationCapability: "atomic";
}
