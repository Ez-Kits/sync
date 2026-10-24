import type { ChangeBusEvent, ChangeBusEventDataMap } from "../change-bus";

/** Public lifecycle states emitted by a sync client. */
export type SyncStatus = "stopped" | "starting" | "syncing" | "idle" | "offline" | "error";

export interface SyncStatusEvent {
  status: SyncStatus;
  /** Present when status is `error`. */
  error?: unknown;
  /** Number of locally queued events, when available. */
  pendingEvents?: number;
  changedAt: number;
}

/** App supplied policy for reconciling an incoming remote event with local data. */
export type ConflictResolution<
  C extends ChangeBusEventDataMap,
  N extends keyof C = keyof C,
> = (options: {
  remote: ChangeBusEvent<C, N>;
  local: unknown;
}) => "remote" | "local" | { data: unknown } | Promise<"remote" | "local" | { data: unknown }>;

export interface SyncAdapter<
  C extends ChangeBusEventDataMap,
  N extends keyof C = keyof C,
  TCheckpoint = unknown,
> {
  /** Open a pull stream. A returned cleanup function must stop every listener. */
  pull(options: PullOptions<C, N, TCheckpoint>): void | (() => void) | Promise<void | (() => void)>;
  /** Resolve only after the provider has durably accepted every supplied event. */
  push(options: PushOptions<C, N>): void | Promise<void>;
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
