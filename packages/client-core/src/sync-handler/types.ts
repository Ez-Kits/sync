import type { ChangeBusEvent, ChangeBusEventDataMap } from "../change-bus";

export interface SyncOptions<
  C extends ChangeBusEventDataMap,
  N extends keyof C = keyof C,
  TCheckpoint = unknown,
> {
  /**
   * Pull changes from the remote server.
   * This function is called once when the sync client is initialized.
   * Setup your sync stream here.
   * @param options - The options for the pull operation.
   * @returns A function to clean up the pull operation.
   */
  pull(options: PullOptions<C, N, TCheckpoint>): void | (() => void);

  /**
   * Push changes to the remote server.
   * This function is called when local changes.
   * @param options - The options for the push operation.
   */
  push(options: PushOptions<C, N>): void;
}

export type PullCheckpointMap<
  C extends ChangeBusEventDataMap,
  N extends keyof C = keyof C,
  TCheckpoint = unknown,
> = Partial<{
  [K in N]: TCheckpoint;
}>;

export interface PullOptions<
  C extends ChangeBusEventDataMap,
  N extends keyof C = keyof C,
  TCheckpoint = unknown,
> {
  /**
   * The checkpoint to use for the pull operation.
   * This is used to resume the pull operation from the last checkpoint.
   * If not provided, the pull operation will start from the beginning.
   */
  checkpoint?: PullCheckpointMap<C, N, TCheckpoint>;

  /**
   * Commit changes to the local database.
   * @param options - The options for the commit operation.
   */
  commitChanges: (options: PullCommitChangesOptions<C, N, TCheckpoint>) => void;
}

export interface PullCommitChangesOptions<
  C extends ChangeBusEventDataMap,
  N extends keyof C = keyof C,
  TCheckpoint = unknown,
> {
  /**
   * The changes to commit to the local database.
   */
  changes: ChangeBusEvent<C, N>[];

  /**
   * New checkpoint to use for the next pull operation.
   */
  checkpoint: PullCheckpointMap<C, N, TCheckpoint>;
}

export interface PushOptions<C extends ChangeBusEventDataMap, N extends keyof C = keyof C> {
  /**
   * The events to push to the remote server.
   */
  events: ChangeBusEvent<C, N>[];

  /**
   * Commit changes after successful sync.
   * @param options - The options for the commit operation.
   */
  commitChanges: (options: PushCommitChangesOptions<C, N>) => void;
}

export interface PushCommitChangesOptions<
  C extends ChangeBusEventDataMap,
  N extends keyof C = keyof C,
> {
  /**
   * The events to commit after successful sync.
   */
  events: ChangeBusEvent<C, N>[];
}
