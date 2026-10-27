/** SQL dialect spoken by a {@link DBStorage}; adapters pick their ORM driver from it. */
export type DBDialect = "sqlite" | "postgres";

/** `leader` holds the real database (and syncs); `follower` reaches it through the leader. */
export type DBRole = "leader" | "follower";

/** One structured-cloneable statement. */
export interface DBQuery {
  sql: string;
  params: unknown[];
  /** `run` returns no rows; `get` is `all` where only the first row is used. */
  method: "run" | "all" | "get";
  /** Rows as positional arrays or as column-keyed objects. Defaults to `array`. */
  rowMode?: "array" | "object";
}

export interface DBQueryResult {
  /** Every result row; `get` callers read `rows[0]`. */
  rows: unknown[];
}

export interface DBExecutor {
  exec(query: DBQuery): Promise<DBQueryResult>;
}

/**
 * The contract between DB adapters and a database engine. The engine lives in one
 * leader context (usually a worker); every other context forwards to it, so adapters
 * see the same storage whichever context they run in.
 */
export interface DBStorage extends DBExecutor {
  readonly dialect: DBDialect;
  /** Contexts sharing one database use the same key. */
  readonly key: string;
  /** Resolves once this context can query, as leader or follower. */
  readonly ready: Promise<void>;
  readonly role: DBRole;
  onRoleChange(listener: (role: DBRole) => void): () => void;
  /** The leader changed: notifications may have been missed, so re-read everything. */
  onInvalidate(listener: () => void): () => void;
  /** The engine failed to open or coordination is unavailable. */
  onError(listener: (error: unknown) => void): () => void;
  /**
   * Run statements in one transaction on the leader. The leader serves no other
   * statement until it commits or rolls back. Do not send `BEGIN`/`COMMIT` yourself.
   */
  transaction<T>(fn: (tx: DBExecutor) => Promise<T>): Promise<T>;
  /** Release leadership and the engine, and stop listening to other contexts. */
  close(): Promise<void>;
}

/** The real database, opened only by the leader. */
export interface DBEngine extends DBExecutor {
  /** Make committed state durable; called after every commit and every write outside one. */
  flush?(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenDBEngineContext {
  /** Aborted when this context stops leading. */
  readonly signal: AbortSignal;
}

export type OpenDBEngine<TOptions = unknown> = (
  options: TOptions,
  context: OpenDBEngineContext,
) => DBEngine | Promise<DBEngine>;
