import type {
  ChangeBusEvent,
  ChangeBusEventDataMap,
  ChangeBusEventDataMapFromCollectionConfigMap,
  ChangeBusSubscribeOptions,
} from "../change-bus";
import type { ICheckpointStorage } from "../checkpoint-storage";
import type { AtomicLocalMutationStorage } from "./storage-pair";
import type { AtomicLocalChangeStore } from "../local-change-store";
import type {
  CollectionConfigMap,
  CollectionNames,
  InferCheckpointMap,
  TCollectionRuntimeRecord,
} from "../collection";
import type { BaseDBAdapter } from "../db-adapter/types";
import type { ConflictResolution, SyncAdapter, SyncStatusEvent } from "../sync-handler";

export interface SyncClientConfig<
  C extends CollectionConfigMap<TCheckpoint>,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
  Store extends AtomicLocalChangeStore,
> {
  collections: C;
  storage: AtomicLocalMutationStorage<DB, Store>;
  syncAdapter?: SyncAdapter<
    ChangeBusEventDataMapFromCollectionConfigMap<C>,
    CollectionNames<C>,
    TCheckpoint
  >;
  checkpointStorage: ICheckpointStorage<CollectionNames<C>, TCheckpoint>;
  /** Optional lifecycle notifications. Sync errors never include document payloads. */
  onSyncStatus?: (event: SyncStatusEvent) => void;
  /** Resolves a remote change when the same record has unpushed local writes. */
  resolveConflict?: ConflictResolution<ChangeBusEventDataMapFromCollectionConfigMap<C>>;
  /** Browser clients sharing a local store should use the same coordination key. */
  coordinationKey?: string;
  /** Disable browser tab leadership for applications that manage it externally. */
  coordinateTabs?: boolean;
}

export interface SyncClient<
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint = InferCheckpointMap<C>,
> {
  collections: TCollectionRuntimeRecord<C>;
  subscribe: SubscribeFn<C>;
  liveQuery: LiveQueryFn<C, DB>;
  startSync: () => void;
  stopSync: () => void;
  /** Stop sync and release browser listeners/resources permanently. */
  dispose: () => void;
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
