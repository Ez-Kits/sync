import type {
  ChangeBusEvent,
  ChangeBusEventDataMap,
  ChangeBusEventDataMapFromCollectionConfigMap,
  ChangeBusSubscribeOptions,
} from "../change-bus";
import type { DBRole } from "../db-storage";
import type {
  CollectionConfigMap,
  CollectionNames,
  InferCheckpointMap,
  TCollectionRuntimeRecord,
} from "../collection";
import type { BaseDBAdapter } from "../db-adapter/types";
import type {
  CheckpointSerializer,
  ConflictResolution,
  PushRejection,
  SyncAdapter,
  SyncStatusEvent,
} from "../sync-handler";
import type { PendingWrites, WaitForPushedOptions } from "./pending-writes";

/**
 * The client-level sync adapter type for collections `C`. A custom adapter factory that takes
 * the collection configs (`createMyAdapter({ collections: [todos] })`) and returns this infers
 * every type from them; called inline in `createSyncClient`, it needs no type argument.
 */
export type SyncAdapterFor<C extends CollectionConfigMap, TCheckpoint = unknown> = SyncAdapter<
  ChangeBusEventDataMapFromCollectionConfigMap<C>,
  CollectionNames<C>,
  TCheckpoint
>;

export interface SyncClientConfig<
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> {
  collections: C;
  /** The adapter (and through it, the `DBStorage`) this client reads from and writes to. */
  dbAdapter: DB;
  syncAdapter?: SyncAdapterFor<C, TCheckpoint>;
  /**
   * How pull checkpoints are turned into strings and back. Checkpoints are always stored in
   * the database of `dbAdapter`, next to the synced rows and the outbox: each one is saved in
   * the transaction that commits the pulled rows it describes, so both commit or roll back
   * together. A database that is lost or reset loses its checkpoints with its rows, and the
   * next pull starts from scratch and fetches everything again.
   *
   * Defaults to the `checkpointSerializer` of the sync adapter that syncs the collection, else
   * to `JSON.stringify` / `JSON.parse`, which only round-trips plain JSON values. A checkpoint
   * that holds anything else, such as a `Date`, needs a serializer that rebuilds it, otherwise
   * the next pull resumes from a plain object. Set here, it replaces the adapters'.
   */
  checkpointSerializer?: CheckpointSerializer<TCheckpoint>;
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
  /**
   * Count the local writes the backend has not confirmed yet: outbox events, so two writes
   * to one record count twice. Works in every context, before `startSync` and offline.
   * `rejected` counts the parked writes the leading context knows of: after a reload, a
   * parked write counts as rejected again once its next push is refused.
   */
  getPendingWrites: () => Promise<PendingWrites<CollectionNames<C>>>;
  /**
   * Called with the pending writes once read, then whenever they change: after a local write
   * commits (in any context), a push is confirmed, a write is parked or discarded, or a pull
   * resolves a conflict. Returns an unsubscribe function.
   */
  subscribePendingWrites: (
    listener: (pending: PendingWrites<CollectionNames<C>>) => void,
  ) => () => void;
  /**
   * Resolve once every pending write but the parked ones is pushed (`total === rejected`),
   * e.g. before deleting the database at sign-out; check `rejected` separately. Rejects with
   * a `WaitForPushedError` when writes are pending while offline, after `timeoutMs`, or on
   * `dispose`. Nothing pushes unless sync runs in the leading context.
   */
  waitForPushed: (options?: WaitForPushedOptions) => Promise<void>;
  /**
   * The last committed pull checkpoint of a collection, read from the database (deserialized
   * with `checkpoint.deserialize`). Waits for the storage to be initialized.
   */
  getCheckpoint: <N extends CollectionNames<C>>(collection: N) => Promise<TCheckpoint | undefined>;
  /**
   * Replace a collection's checkpoint in the database; `undefined` removes it, so the next pull
   * of that collection starts from scratch. Takes effect when the collection's pull stream
   * (re)subscribes. Waits for the storage to be initialized.
   */
  saveCheckpoint: <N extends CollectionNames<C>>(
    collection: N,
    checkpoint: TCheckpoint | undefined,
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
