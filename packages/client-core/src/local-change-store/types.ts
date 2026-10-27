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

export interface ILocalChangeStore<TTransactionContext = unknown> {
  /**
   * Create the outbox and dirty-record storage when it is missing. The sync client calls it
   * once the DB storage is ready and before any read, write or sync, in every context, so it
   * must be idempotent. Applications never run these migrations themselves.
   */
  initialize(): Promise<void>;
  appendEvents(
    events: StoredChangeBusEvent[],
    transactionContext?: TTransactionContext,
  ): Promise<void>;
  getPendingEvents(collection?: string): Promise<StoredChangeBusEvent[]>;
  deleteEvents(ids: string[], transactionContext?: TTransactionContext): Promise<void>;
  upsertDirtyRecord(record: DirtyRecord, transactionContext?: TTransactionContext): Promise<void>;
  removeDirtyRecords(
    keys: DirtyRecordKey[],
    transactionContext?: TTransactionContext,
  ): Promise<void>;
  getDirtyRecords(collection?: string): Promise<DirtyRecord[]>;
}

export interface AtomicLocalChangeStore<
  TTransactionContext = unknown,
> extends ILocalChangeStore<TTransactionContext> {
  readonly atomicLocalMutationCapability: "atomic";
}
