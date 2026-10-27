import { DBStorageClosedError, deserializeError } from "./errors";
import type { NodeOptions, NodeRequestBody, PortMessage, PortRequest } from "./protocol";
import type { DBDialect, DBExecutor, DBQuery, DBQueryResult, DBRole, DBStorage } from "./types";

/** A `Worker`, `MessagePort` or worker global scope. */
export interface MessageEndpoint {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

type PageLifecycleHost = {
  addEventListener?: (type: string, listener: (event: { persisted?: boolean }) => void) => void;
  removeEventListener?: (type: string, listener: (event: { persisted?: boolean }) => void) => void;
};

export interface WorkerDBStorageOptions<TEngineOptions = unknown> {
  dialect: DBDialect;
  /** Contexts sharing one database must use the same key. Defaults to `"default"`. */
  key?: string;
  /** Start the storage worker; it must call `startDBStorageWorker`. */
  worker: () => Worker | MessageEndpoint;
  /** Structured-cloneable options handed to the worker's engine opener. */
  engineOptions?: TEngineOptions;
  /** Follower request timeout before the leader is probed again. Defaults to 10 seconds. */
  requestTimeoutMs?: number;
  /** Idle time after which the leader rolls an open transaction back. Defaults to 10 seconds. */
  transactionTimeoutMs?: number;
}

/**
 * A {@link DBStorage} whose database lives in a dedicated worker. Each context starts its
 * own worker; the workers elect a leader that opens the engine, and the others forward
 * to it. Release leadership while the page sits in the back/forward cache.
 */
export function createWorkerDBStorage<TEngineOptions = unknown>(
  options: WorkerDBStorageOptions<TEngineOptions>,
): DBStorage {
  const key = options.key ?? "default";
  const endpoint = options.worker();
  return new PortDBStorage(
    options.dialect,
    key,
    endpoint,
    {
      key,
      clientId: crypto.randomUUID(),
      requestTimeoutMs: options.requestTimeoutMs,
      transactionTimeoutMs: options.transactionTimeoutMs,
    },
    options.engineOptions,
  );
}

class PortDBStorage implements DBStorage {
  readonly ready: Promise<void>;
  role: DBRole = "follower";
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  private readonly roleListeners = new Set<(role: DBRole) => void>();
  private readonly invalidateListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: unknown) => void>();
  private settleReady: { resolve(): void; reject(error: unknown): void } | undefined;
  private nextId = 0;
  private closed: Promise<void> | undefined;
  private pageCleanup: (() => void) | undefined;

  constructor(
    readonly dialect: DBDialect,
    readonly key: string,
    private readonly endpoint: MessageEndpoint,
    node: NodeOptions,
    engineOptions: unknown,
    host: PageLifecycleHost = globalThis as PageLifecycleHost,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.settleReady = { resolve, reject };
    });
    // Readiness failures surface through `ready` consumers.
    this.ready.catch(() => undefined);
    endpoint.onmessage = (event: MessageEvent) => this.handleMessage(event.data as PortMessage);
    this.post({ t: "init", ...node, engineOptions });
    this.watchPageLifecycle(host);
  }

  exec(query: DBQuery): Promise<DBQueryResult> {
    return this.call({ t: "exec", query }) as Promise<DBQueryResult>;
  }

  async transaction<T>(fn: (tx: DBExecutor) => Promise<T>): Promise<T> {
    const txId = (await this.call({ t: "begin" })) as string;
    let result: T;
    try {
      result = await fn({
        exec: (query) => this.call({ t: "exec", query, txId }) as Promise<DBQueryResult>,
      });
    } catch (error) {
      await this.call({ t: "rollback", txId }).catch(() => undefined);
      throw error;
    }
    await this.call({ t: "commit", txId });
    return result;
  }

  onRoleChange(listener: (role: DBRole) => void): () => void {
    this.roleListeners.add(listener);
    return () => this.roleListeners.delete(listener);
  }

  onInvalidate(listener: () => void): () => void {
    this.invalidateListeners.add(listener);
    return () => this.invalidateListeners.delete(listener);
  }

  onError(listener: (error: unknown) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  close(): Promise<void> {
    this.closed ??= this.shutdown();
    return this.closed;
  }

  private async shutdown(): Promise<void> {
    this.pageCleanup?.();
    const id = ++this.nextId;
    await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ t: "close", id });
    });
    for (const pending of this.pending.values()) pending.reject(new DBStorageClosedError());
    this.pending.clear();
    this.settleReady?.reject(new DBStorageClosedError());
    this.roleListeners.clear();
    this.invalidateListeners.clear();
    this.errorListeners.clear();
    (this.endpoint as Partial<Worker>).terminate?.();
  }

  private call(body: NodeRequestBody): Promise<unknown> {
    if (this.closed) return Promise.reject(new DBStorageClosedError());
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ t: "request", id, body });
    });
  }

  private post(message: PortRequest): void {
    this.endpoint.postMessage(message);
  }

  private handleMessage(message: PortMessage): void {
    switch (message?.t) {
      case "role":
        this.role = message.role;
        this.settleReady?.resolve();
        this.settleReady = undefined;
        for (const listener of this.roleListeners) listener(message.role);
        return;
      case "invalidate":
        for (const listener of this.invalidateListeners) listener();
        return;
      case "error": {
        const error = deserializeError(message.error);
        this.settleReady?.reject(error);
        this.settleReady = undefined;
        for (const listener of this.errorListeners) listener(error);
        return;
      }
      case "response": {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(deserializeError(message.error));
        return;
      }
    }
  }

  /** Step down while the page sits in the back/forward cache; compete again on return. */
  private watchPageLifecycle(host: PageLifecycleHost): void {
    const { addEventListener, removeEventListener } = host;
    if (!addEventListener || !removeEventListener) return;
    const onPageHide = () => this.post({ t: "release" });
    const onPageShow = (event: { persisted?: boolean }) => {
      if (event.persisted) this.post({ t: "rejoin" });
    };
    addEventListener.call(host, "pagehide", onPageHide);
    addEventListener.call(host, "pageshow", onPageShow);
    this.pageCleanup = () => {
      removeEventListener.call(host, "pagehide", onPageHide);
      removeEventListener.call(host, "pageshow", onPageShow);
    };
  }
}
