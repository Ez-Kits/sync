export interface ICheckpointStorage<TCollectionName, TCheckpoint> {
  getCheckpoint(collectionName: TCollectionName): Promise<TCheckpoint | undefined>;
  saveCheckpoint(collectionName: TCollectionName, checkpoint: TCheckpoint): Promise<void>;
}

/** Resolves the checkpoint payload type from a concrete storage implementation. */
export type InferCheckpointFromStorage<S> =
  S extends ICheckpointStorage<any, infer CP> ? CP : unknown;
