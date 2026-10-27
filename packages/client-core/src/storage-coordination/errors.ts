/** Exclusive storage needs Web Locks and BroadcastChannel to elect a single owner. */
export class CoordinationUnavailableError extends Error {
  override readonly name = "CoordinationUnavailableError";
  constructor() {
    super(
      'Exclusive storage requires Web Locks and BroadcastChannel. Use sharing: "shared" or coordinateTabs: false.',
    );
  }
}

/** Follower adapters cannot open transactions; writes go through collection runtimes. */
export class FollowerWriteError extends Error {
  override readonly name = "FollowerWriteError";
  constructor(operation: string) {
    super(`${operation} is only available in the storage owner context.`);
  }
}

/** A follower request could not reach a live storage owner. */
export class StorageOwnerUnavailableError extends Error {
  override readonly name = "StorageOwnerUnavailableError";
  readonly retriable = true;
  constructor() {
    super("The storage owner did not respond.");
  }
}
