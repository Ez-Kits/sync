import type { ICheckpointStorage } from "./types";

export interface LocalStorageCheckpointStorageConfig<TCheckpoint> {
  key: string;
  serializer: (checkpoint: TCheckpoint) => string | undefined;
  deserializer: (value: string) => TCheckpoint | undefined;
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
