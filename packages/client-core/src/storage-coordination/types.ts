import type { BaseDBAdapter } from "../db-adapter";
import type { AtomicLocalChangeStore } from "../local-change-store";

/** `owner` holds the storage (and may sync); `follower` reaches it through the owner. */
export type StorageRole = "owner" | "follower";

/**
 * - `exclusive`: the database lives in one context at a time (in-memory, WASM, per-tab
 *   worker). Only the elected owner opens it; other tabs proxy reads and writes to it.
 * - `shared`: the engine is already shared and transactional across contexts. Every tab
 *   opens its own handle; only sync leadership is coordinated.
 */
export type StorageSharing = "exclusive" | "shared";

export interface OpenContext {
  /** Unique id of this ownership term. */
  readonly epoch: string;
  /** Aborted when this context stops owning the database. */
  readonly signal: AbortSignal;
}

export interface OpenedDatabase<TDatabase> {
  database: TDatabase;
  /** Make committed state durable; awaited before a follower's write is acknowledged. */
  flush?(): Promise<void>;
  /** Release the engine when ownership ends. */
  close?(): Promise<void>;
}

export interface OwnedDatabase<TDatabase, TRequest, TResponse> extends OpenedDatabase<TDatabase> {
  /** Run one structured-cloneable request from a follower against the real engine. */
  execute(request: TRequest): Promise<TResponse>;
}

interface CoordinatedStorageBaseOptions<
  TDatabase,
  DB extends BaseDBAdapter<any, any, any>,
  Store extends AtomicLocalChangeStore,
> {
  /** Contexts sharing a database must use the same key. Defaults to `"default"`. */
  coordinationKey?: string;
  /** `false` disables cross-tab coordination; this context always owns the storage. */
  coordinateTabs?: boolean;
  /** Build the adapter; also used on followers with the proxied database. */
  createDBAdapter(database: TDatabase): DB;
  /** Build the outbox on the same database handle as the adapter. */
  createLocalChangeStore(database: TDatabase): Store;
  /** Follower request timeout before the owner is probed again. Defaults to 10 seconds. */
  requestTimeoutMs?: number;
}

export interface ExclusiveStorageOptions<
  TDatabase,
  DB extends BaseDBAdapter<any, any, any>,
  Store extends AtomicLocalChangeStore,
  TRequest,
  TResponse,
> extends CoordinatedStorageBaseOptions<TDatabase, DB, Store> {
  sharing?: "exclusive";
  /** Open the real database. Runs only in the owner context. */
  open(
    context: OpenContext,
  ):
    | OwnedDatabase<TDatabase, TRequest, TResponse>
    | Promise<OwnedDatabase<TDatabase, TRequest, TResponse>>;
  /** Build a database handle whose I/O is forwarded to the owner's `execute`. */
  connect(send: (request: TRequest) => Promise<TResponse>): TDatabase;
}

export interface SharedStorageOptions<
  TDatabase,
  DB extends BaseDBAdapter<any, any, any>,
  Store extends AtomicLocalChangeStore,
> extends CoordinatedStorageBaseOptions<TDatabase, DB, Store> {
  sharing: "shared";
  /** Open this context's handle to the shared database. Runs in every context. */
  open(context: OpenContext): OpenedDatabase<TDatabase> | Promise<OpenedDatabase<TDatabase>>;
  connect?: never;
}

export type CoordinatedStorageOptions<
  TDatabase,
  DB extends BaseDBAdapter<any, any, any>,
  Store extends AtomicLocalChangeStore,
  TRequest = unknown,
  TResponse = unknown,
> =
  | ExclusiveStorageOptions<TDatabase, DB, Store, TRequest, TResponse>
  | SharedStorageOptions<TDatabase, DB, Store>;
