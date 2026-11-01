import type { CollectionPullState, PullStateEvent } from "../sync-handler";

/** Every pulled collection's state, by collection name. */
export type PullState<TCollectionName extends string = string> = Record<
  TCollectionName,
  CollectionPullState
>;

export interface WaitForPulledOptions<TCollectionName extends string = string> {
  /** Collections to wait for. Default: every pulled collection. */
  collections?: readonly TCollectionName[];
  /**
   * `"available"`: until local data can be shown; `"caughtUp"` (default): until the
   * backend's current state is applied.
   */
  until?: "available" | "caughtUp";
  /** Reject with a `WaitForPulledError` (`reason: "timeout"`) after this long. Default: never. */
  timeoutMs?: number;
}

/** Why `waitForPulled` gave up, with the last pull state it saw. */
export class WaitForPulledError extends Error {
  override readonly name = "WaitForPulledError";

  constructor(
    readonly reason: "timeout" | "stopped" | "disposed",
    readonly state: PullState,
  ) {
    super(
      reason === "timeout"
        ? "Timed out waiting for the pull."
        : reason === "stopped"
          ? "Sync was stopped before the pull was done."
          : "The sync client was disposed.",
    );
  }
}

const initialState = (): CollectionPullState => ({
  available: false,
  hasRemoteData: undefined,
  caughtUp: false,
  progress: { pulled: 0, total: undefined },
  lastPulledAt: undefined,
});

function reduce(state: CollectionPullState, event: PullStateEvent): CollectionPullState {
  switch (event.type) {
    case "started":
      return { ...state, caughtUp: false, progress: { pulled: 0, total: undefined } };
    case "stopped":
      return state.caughtUp ? { ...state, caughtUp: false } : state;
    case "committed":
      return {
        ...state,
        progress: { ...state.progress, pulled: state.progress.pulled + event.count },
        lastPulledAt: event.at,
      };
    case "previewed":
      return { ...state, available: true, hasRemoteData: state.hasRemoteData || event.hasData };
    case "count":
      return { ...state, progress: { ...state.progress, total: event.total } };
    case "caughtUp":
      return {
        ...state,
        available: true,
        caughtUp: true,
        hasRemoteData: state.hasRemoteData ?? state.progress.pulled > 0,
        lastPulledAt: event.at,
      };
  }
}

/** The pull state of every pulled collection, kept by the leader and copied to followers. */
export class PullStateTracker {
  private state: PullState;
  private listeners = new Set<(state: PullState) => void>();

  constructor(
    collections: readonly string[],
    /** Called after every change, e.g. to send the state to the other contexts. */
    private readonly onChange: (state: PullState) => void,
  ) {
    this.state = Object.fromEntries(collections.map((name) => [name, initialState()]));
  }

  get current(): PullState {
    return this.state;
  }

  has(collection: string): boolean {
    return collection in this.state;
  }

  apply(collection: string, event: PullStateEvent): void {
    const previous = this.state[collection];
    if (!previous) return;
    const next = reduce(previous, event);
    if (next !== previous) this.set({ ...this.state, [collection]: next });
  }

  /** Collections pulled before on this device: their local data can be shown. */
  markCheckpointed(collections: readonly string[]): void {
    const next = { ...this.state };
    let changed = false;
    for (const name of collections) {
      const previous = next[name];
      if (!previous || previous.available) continue;
      next[name] = { ...previous, available: true, hasRemoteData: previous.hasRemoteData ?? true };
      changed = true;
    }
    if (changed) this.set(next);
  }

  /** Take the leader's state; collections this context does not pull are ignored. */
  replace(state: PullState): void {
    const next = { ...this.state };
    for (const name of Object.keys(next)) if (state[name]) next[name] = state[name];
    this.set(next, false);
  }

  /** Called now with the current state, then on every change. */
  subscribe(listener: (state: PullState) => void): () => void {
    this.listeners.add(listener);
    call(listener, this.state);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
  }

  private set(state: PullState, notify = true): void {
    this.state = state;
    for (const listener of this.listeners) call(listener, state);
    if (notify) this.onChange(state);
  }
}

function call(listener: (state: PullState) => void, state: PullState): void {
  try {
    listener(state);
  } catch {
    // One observer must not block delivery to other observers.
  }
}
