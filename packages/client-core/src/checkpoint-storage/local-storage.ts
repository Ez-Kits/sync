import type { CheckpointSerialization, ICheckpointStorage } from "./types";

/**
 * Configuration of {@link createLocalStorageCheckpointStorage}. Prefer
 * `createDBCheckpointStorage`: localStorage outlives a database that is lost or reset, and a
 * checkpoint that survives its rows makes the next pull skip every change before it.
 */
export interface LocalStorageCheckpointStorageConfig<
  TCheckpoint,
> extends CheckpointSerialization<TCheckpoint> {
  key: string;
}

export function createLocalStorageCheckpointStorage<TCollectionName, TCheckpoint>(
  config: LocalStorageCheckpointStorageConfig<TCheckpoint>,
): ICheckpointStorage<TCollectionName, TCheckpoint> {
  const key = (collectionName: TCollectionName) => `${config.key}-${String(collectionName)}`;
  return {
    getCheckpoint: async (collectionName: TCollectionName) => {
      const checkpoint = localStorage.getItem(key(collectionName));
      return checkpoint ? config.deserializer(checkpoint) : undefined;
    },
    saveCheckpoint: async (collectionName: TCollectionName, checkpoint: TCheckpoint) => {
      const serialized = config.serializer(checkpoint);
      if (serialized) {
        localStorage.setItem(key(collectionName), serialized);
      } else {
        localStorage.removeItem(key(collectionName));
      }
    },
  };
}
