import type { ILocalChangeStore } from "../local-change-store";

export interface ICheckpointStorage<TCollectionName, TCheckpoint> {
  getCheckpoint(collectionName: TCollectionName): Promise<TCheckpoint | undefined>;
  saveCheckpoint(collectionName: TCollectionName, checkpoint: TCheckpoint): Promise<void>;
}

/**
 * A checkpoint storage kept in a local-change store, so in the database of the outbox and
 * the synced rows. Sync handlers whose adapter uses that store save each pulled checkpoint
 * inside the transaction that commits the pulled rows: both commit or roll back together,
 * and a database that is lost or reset loses its checkpoints with its rows. As with every
 * store method, `transactionContext` is the `native` handle of an open adapter transaction.
 */
export interface TransactionalCheckpointStorage<
  TCollectionName,
  TCheckpoint,
> extends ICheckpointStorage<TCollectionName, TCheckpoint> {
  /** The store checkpoints are kept in; the sync client requires its adapter's own. */
  readonly localChangeStore: ILocalChangeStore;
  getCheckpoint(
    collectionName: TCollectionName,
    transactionContext?: unknown,
  ): Promise<TCheckpoint | undefined>;
  saveCheckpoint(
    collectionName: TCollectionName,
    checkpoint: TCheckpoint,
    transactionContext?: unknown,
  ): Promise<void>;
}

/**
 * How a checkpoint storage turns checkpoints into strings and back. Checkpoints may hold
 * values JSON cannot represent, such as a Firestore `Timestamp`. A serializer that returns
 * `undefined` removes the stored checkpoint.
 */
export interface CheckpointSerialization<TCheckpoint> {
  serializer: (checkpoint: TCheckpoint) => string | undefined;
  deserializer: (value: string) => TCheckpoint | undefined;
}

/** Resolves the checkpoint payload type from a concrete storage implementation. */
export type InferCheckpointFromStorage<S> =
  S extends ICheckpointStorage<any, infer CP> ? CP : unknown;
