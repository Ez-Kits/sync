import type { ILocalChangeStore } from "../local-change-store";
import type {
  CheckpointSerialization,
  ICheckpointStorage,
  TransactionalCheckpointStorage,
} from "./types";

export interface DBCheckpointStorageConfig<
  TCheckpoint,
> extends CheckpointSerialization<TCheckpoint> {
  /** The local-change store of the sync client's adapter (`dbAdapter.localChangeStore`). */
  localChangeStore: ILocalChangeStore;
}

/**
 * Keep checkpoints in the database, next to the outbox and the synced rows (see
 * {@link TransactionalCheckpointStorage}); each one is stored as its serialized string. It
 * never reads checkpoints another storage saved: after switching to it, the next pull of
 * each collection starts without a checkpoint, once, and fetches everything again.
 */
export function createDBCheckpointStorage<TCollectionName, TCheckpoint>(
  config: DBCheckpointStorageConfig<TCheckpoint>,
): TransactionalCheckpointStorage<TCollectionName, TCheckpoint> {
  const { localChangeStore, serializer, deserializer } = config;
  return {
    localChangeStore,
    async getCheckpoint(collectionName, transactionContext) {
      const value = await localChangeStore.getCheckpoint(
        String(collectionName),
        transactionContext,
      );
      return value === undefined ? undefined : deserializer(value);
    },
    async saveCheckpoint(collectionName, checkpoint, transactionContext) {
      await localChangeStore.saveCheckpoint(
        String(collectionName),
        serializer(checkpoint),
        transactionContext,
      );
    },
  };
}

/** Whether a checkpoint storage joins the transactions of a local-change store. */
export function isTransactionalCheckpointStorage<TCollectionName, TCheckpoint>(
  storage: ICheckpointStorage<TCollectionName, TCheckpoint>,
): storage is TransactionalCheckpointStorage<TCollectionName, TCheckpoint> {
  return (
    (storage as Partial<TransactionalCheckpointStorage<TCollectionName, TCheckpoint>>)
      .localChangeStore !== undefined
  );
}
