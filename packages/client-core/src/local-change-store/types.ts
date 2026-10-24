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
  /** Whether lease transactions coordinate separate browser contexts. */
  readonly supportsCrossContextLeases?: boolean;
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
  /** Acquire or renew an exclusive lease. The token changes on ownership takeover. */
  acquireLease?(
    key: string,
    owner: string,
    now: number,
    ttlMs: number,
  ): Promise<number | undefined>;
  releaseLease?(key: string, owner: string, fencingToken: number): Promise<void>;
}

export interface AtomicLocalChangeStore<
  TTransactionContext = unknown,
> extends ILocalChangeStore<TTransactionContext> {
  readonly atomicLocalMutationCapability: "atomic";
}
