/**
 * Internal: how the sync client keeps pull checkpoints. Not exported from the package entry;
 * applications only choose the serialization (`SyncClientConfig.checkpointSerializer`).
 */
import type { ILocalChangeStore } from "../local-change-store";
import type { CheckpointSerializer } from "../sync-handler/types";

/**
 * Checkpoints kept in a local-change store, so in the database of the outbox and the synced
 * rows. With `transactionContext` (the `native` handle of an open adapter transaction) a call
 * runs in that transaction: a pulled checkpoint commits or rolls back with its rows.
 */
export interface CheckpointStorage<TCollectionName, TCheckpoint> {
  getCheckpoint(
    collectionName: TCollectionName,
    transactionContext?: unknown,
  ): Promise<TCheckpoint | undefined>;
  /** `undefined` removes the checkpoint: the next pull of the collection starts from scratch. */
  saveCheckpoint(
    collectionName: TCollectionName,
    checkpoint: TCheckpoint | undefined,
    transactionContext?: unknown,
  ): Promise<void>;
}

export const jsonCheckpointSerializer: CheckpointSerializer<any> = {
  serialize: (checkpoint) => JSON.stringify(checkpoint),
  deserialize: (value) => JSON.parse(value),
};

export function createCheckpointStorage<TCollectionName, TCheckpoint>(
  localChangeStore: ILocalChangeStore,
  /** The serializer of a collection's checkpoints; JSON when it returns `undefined`. */
  serializerFor: (collectionName: string) => CheckpointSerializer<TCheckpoint> | undefined = () =>
    undefined,
): CheckpointStorage<TCollectionName, TCheckpoint> {
  const serializer = (collectionName: TCollectionName) =>
    serializerFor(String(collectionName)) ?? jsonCheckpointSerializer;
  return {
    async getCheckpoint(collectionName, transactionContext) {
      const value = await localChangeStore.getCheckpoint(
        String(collectionName),
        transactionContext,
      );
      return value === undefined ? undefined : serializer(collectionName).deserialize(value);
    },
    async saveCheckpoint(collectionName, checkpoint, transactionContext) {
      await localChangeStore.saveCheckpoint(
        String(collectionName),
        checkpoint === undefined ? undefined : serializer(collectionName).serialize(checkpoint),
        transactionContext,
      );
    },
  };
}
