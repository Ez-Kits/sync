import type {
  ChangeBusEvent,
  ChangeBusEventDataMap,
  ChangeBusEventDataMapFromCollectionConfigMap,
  ChangeBusSubscribeOptions,
} from "../change-bus";
import type { ICheckpointStorage } from "../checkpoint-storage";
import type { DBRole } from "../db-storage";
import type {
  CollectionConfigMap,
  CollectionNames,
  InferCheckpointMap,
  TCollectionRuntimeRecord,
} from "../collection";
import type { BaseDBAdapter } from "../db-adapter/types";
import type {
  ConflictResolution,
  PushRejection,
  SyncAdapter,
  SyncStatusEvent,
} from "../sync-handler";

export interface SyncClientConfig<
  C extends CollectionConfigMap<TCheckpoint>,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> {
  collections: C;
  /** The adapter (and through it, the `DBStorage`) this client reads from and writes to. */
  dbAdapter: DB;
  syncAdapter?: SyncAdapter<
    ChangeBusEventDataMapFromCollectionConfigMap<C>,
    CollectionNames<C>,
    TCheckpoint
  >;
  /**
   * Where pull checkpoints are kept. Prefer `createDBCheckpointStorage` over
   * `dbAdapter.localChangeStore`: checkpoints then commit in the transaction of the rows they
   * describe and are lost with them. A storage kept elsewhere (such as localStorage) is saved
   * after each pull commits, and can outlive a database that is lost or reset, so the next
   * pull would skip every remote change before the surviving checkpoint.
   */
  checkpointStorage: ICheckpointStorage<CollectionNames<C>, TCheckpoint>;
  /** Optional lifecycle notifications. Sync errors never include document payloads. */
  onSyncStatus?: (event: SyncStatusEvent) => void;
  /**
   * Resolves a remote change when the same record has unpushed local writes. Without it the
   * local writes win: the remote change is skipped and they are pushed over it.
   */
  resolveConflict?: ConflictResolution<ChangeBusEventDataMapFromCollectionConfigMap<C>>;
  /**
   * Called once for each local write the provider refused when pushed alone
   * (`PushRejectedError`, e.g. security rules or validation). The write is parked, not lost:
   * it stays in the outbox, later writes of its record wait behind it, and it is retried with
   * a backoff, on every sync start and on `retryRejectedPushes()`. Each push that parks
   * writes also reports the error through `onSyncStatus`. Call `rejection.discard()` to drop
   * a write that can never succeed; the local row keeps its value, so revert or fix it, for
   * example by re-reading the record from the remote.
   */
  onPushRejected?: (
    rejection: PushRejection<ChangeBusEventDataMapFromCollectionConfigMap<C>>,
  ) => void;
}

export interface SyncClient<
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint = InferCheckpointMap<C>,
> {
  collections: TCollectionRuntimeRecord<C>;
  subscribe: SubscribeFn<C>;
  liveQuery: LiveQueryFn<C, DB>;
  /** Start syncing; on a follower, also asks the leader to sync. */
  startSync: () => void;
  stopSync: () => void;
  /**
   * Push the writes parked after a rejection (`onPushRejected`) now instead of after their
   * backoff, e.g. once the user signed in. Acts in the leading context, which runs sync.
   */
  retryRejectedPushes: () => void;
  /** Stop sync, release the storage and browser listeners permanently. */
  dispose: () => Promise<void>;
  /** Whether this context leads the storage (and is the only one that syncs). */
  readonly role: DBRole;
  /** Subscribe to role changes; the current role is emitted immediately. */
  subscribeRole: (listener: (role: DBRole) => void) => () => void;
  /** Subscribe to lifecycle notifications; the current status is emitted immediately. */
  subscribeStatus: (listener: (event: SyncStatusEvent) => void) => () => void;
  getCheckpoint: <N extends CollectionNames<C>>(collection: N) => Promise<TCheckpoint | undefined>;
  saveCheckpoint: <N extends CollectionNames<C>>(
    collection: N,
    checkpoint: TCheckpoint,
  ) => Promise<void>;
}

export interface SubscribeFn<
  C extends CollectionConfigMap,
  TDataMap extends ChangeBusEventDataMap = ChangeBusEventDataMapFromCollectionConfigMap<C>,
> {
  (
    cb: (events: ChangeBusEvent<TDataMap>[]) => void,
    options?: ChangeBusSubscribeOptions,
  ): () => void;
  <N extends CollectionNames<C>>(
    collection: N,
    cb: (events: ChangeBusEvent<TDataMap, N>[]) => void,
    options?: ChangeBusSubscribeOptions,
  ): () => void;
  <N extends CollectionNames<C>>(
    collections: readonly N[],
    cb: (events: ChangeBusEvent<TDataMap, N>[]) => void,
    options?: ChangeBusSubscribeOptions,
  ): () => void;
}

export type LiveQueryFn<C extends CollectionConfigMap, DB extends BaseDBAdapter<C, any, any>> = <
  TResult,
>(options: {
  collections?: CollectionNames<C>[];
  query: (db: DB["queryBuilder"], schema: DB["querySchema"]) => TResult | PromiseLike<TResult>;
  onData: (data: TResult) => void;
}) => () => void;
