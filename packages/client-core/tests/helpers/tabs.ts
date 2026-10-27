import { vi } from "vite-plus/test";

/** BroadcastChannel fake: delivers asynchronously, in order, to other instances of a name. */
export class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  static posted: Array<{ name: string; data: any }> = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  /** Which simulated tab created the channel. */
  tag: string | undefined;

  constructor(public name: string) {
    FakeBroadcastChannel.instances.push(this);
  }

  static reset() {
    FakeBroadcastChannel.instances = [];
    FakeBroadcastChannel.posted = [];
  }

  static messages(type?: string) {
    return FakeBroadcastChannel.posted
      .map(({ data }) => data)
      .filter((data) => type === undefined || data?.t === type);
  }

  postMessage(data: unknown) {
    if (this.closed) throw new Error("channel closed");
    const cloned = structuredClone(data);
    FakeBroadcastChannel.posted.push({ name: this.name, data: cloned });
    for (const other of FakeBroadcastChannel.instances) {
      if (other === this || other.name !== this.name || other.closed) continue;
      queueMicrotask(() => {
        if (!other.closed) other.onmessage?.({ data: cloned } as MessageEvent);
      });
    }
  }

  close() {
    this.closed = true;
  }
}

type Grant = {
  name: string;
  signal?: AbortSignal;
  callback: (lock: unknown) => unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

/** Web Locks fake with a FIFO queue per lock name. */
export class FakeLockManager {
  held = new Map<string, Grant>();
  queue: Grant[] = [];
  request = vi.fn(
    (
      name: string,
      options: { mode: "exclusive"; signal?: AbortSignal },
      callback: (lock: unknown) => unknown,
    ) =>
      new Promise((resolve, reject) => {
        const grant: Grant = { name, signal: options.signal, callback, resolve, reject };
        options.signal?.addEventListener("abort", () => {
          const index = this.queue.indexOf(grant);
          if (index >= 0) {
            this.queue.splice(index, 1);
            reject(new DOMException("aborted", "AbortError"));
          }
        });
        this.queue.push(grant);
        this.pump();
      }),
  );

  /** Simulate the holder's context dying: the lock is freed without its callback finishing. */
  crash(name = "ez-sync:default") {
    this.held.delete(name);
    this.pump();
  }

  private pump() {
    // Snapshot: granting removes entries from the queue while iterating.
    for (const grant of this.queue.slice()) {
      if (this.held.has(grant.name)) continue;
      this.queue.splice(this.queue.indexOf(grant), 1);
      this.held.set(grant.name, grant);
      void Promise.resolve()
        .then(() => grant.callback({ name: grant.name }))
        .then(grant.resolve, grant.reject)
        .finally(() => {
          if (this.held.get(grant.name) === grant) this.held.delete(grant.name);
          this.pump();
        });
    }
  }
}

/** Stub a browser with Web Locks and BroadcastChannel shared by every "tab" in this process. */
export function installTabs(options: { locks?: boolean; channels?: boolean } = {}) {
  FakeBroadcastChannel.reset();
  const locks = new FakeLockManager();
  vi.stubGlobal("document", {});
  vi.stubGlobal("BroadcastChannel", options.channels === false ? undefined : FakeBroadcastChannel);
  vi.stubGlobal("navigator", { onLine: true, ...(options.locks === false ? {} : { locks }) });
  return { locks, channels: FakeBroadcastChannel };
}

/** Per-tab host for driving `StorageCoordinator` directly with shared locks and channels. */
export function tabHost(locks: FakeLockManager, tag: string) {
  class TabChannel extends FakeBroadcastChannel {
    constructor(name: string) {
      super(name);
      this.tag = tag;
    }
  }
  const listeners = new Map<string, (event: { persisted?: boolean }) => void>();
  return {
    navigator: { onLine: true, locks },
    BroadcastChannel: TabChannel as unknown as new (name: string) => BroadcastChannel,
    document: {},
    listeners,
    addEventListener: (type: string, listener: (event: { persisted?: boolean }) => void) =>
      listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  };
}

/** Kill a simulated tab: its channels go silent and its lock is freed. */
export function crashTab(locks: FakeLockManager, tag: string, lockName = "ez-sync:default") {
  for (const channel of FakeBroadcastChannel.instances) {
    if (channel.tag === tag) channel.close();
  }
  locks.crash(lockName);
}
