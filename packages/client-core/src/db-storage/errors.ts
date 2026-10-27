/** Multi-context storage needs Web Locks and BroadcastChannel to elect a leader. */
export class CoordinationUnavailableError extends Error {
  override readonly name = "CoordinationUnavailableError";
  constructor() {
    super("DB storage requires Web Locks and BroadcastChannel. Use createLocalDBStorage instead.");
  }
}

/** The leader went away while a write or transaction was in flight; retry it. */
export class LeaderChangedError extends Error {
  override readonly name = "LeaderChangedError";
  readonly retriable = true;
  constructor(message = "The database leader changed during the request.") {
    super(message);
  }
}

/** A request could not reach a live database leader. */
export class LeaderUnavailableError extends Error {
  override readonly name = "LeaderUnavailableError";
  readonly retriable = true;
  constructor() {
    super("The database leader did not respond.");
  }
}

/** The transaction was rolled back after staying idle too long, or is otherwise closed. */
export class TransactionClosedError extends Error {
  override readonly name = "TransactionClosedError";
  constructor(message = "The transaction is no longer open.") {
    super(message);
  }
}

/** Statements sent outside `DBStorage.transaction` cannot control transactions. */
export class TransactionStatementError extends Error {
  override readonly name = "TransactionStatementError";
  constructor() {
    super("Use DBStorage.transaction (or the adapter's transaction) instead of BEGIN/COMMIT.");
  }
}

/** The storage was closed. */
export class DBStorageClosedError extends Error {
  override readonly name = "DBStorageClosedError";
  constructor() {
    super("The database storage was closed.");
  }
}

const errorTypes = {
  LeaderChangedError,
  LeaderUnavailableError,
  TransactionClosedError,
  TransactionStatementError,
  DBStorageClosedError,
  CoordinationUnavailableError,
} as const;

export interface SerializedError {
  name: string;
  message: string;
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

/** Rebuild an error from another context, keeping the library's error classes. */
export function deserializeError(error: SerializedError): Error {
  const Type = errorTypes[error.name as keyof typeof errorTypes];
  if (Type) {
    const restored = new Type() as Error;
    restored.message = error.message;
    return restored;
  }
  const restored = new Error(error.message);
  restored.name = error.name;
  return restored;
}

export function isRetriableError(error: unknown): boolean {
  return (error as { retriable?: unknown } | undefined)?.retriable === true;
}
