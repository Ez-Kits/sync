import type { ChangeBusEvent } from "../change-bus";
import {
  executeLocalMutation,
  isLocalMutationCommitted,
  toChangeBusEvent,
  type LocalMutation,
  type MutationSink,
} from "../collection/local-mutation";
import type { BaseDBAdapter } from "../db-adapter";
import type { AtomicLocalChangeStore } from "../local-change-store";
import {
  assertAtomicLocalMutationStorage,
  createAtomicLocalMutationStorage,
} from "../sync-client/storage-pair";
import { CoordinationUnavailableError, FollowerWriteError } from "./errors";
import { FollowerClient } from "./follower-client";
import { Mutex } from "./mutex";
import {
  controlChannelName,
  ownerChannelName,
  tabChannelName,
  type BroadcastChannelConstructor,
  type ControlMessage,
  type OwnerRequest,
  type OwnerRequestBody,
  type OwnerResponse,
} from "./protocol";
import type {
  CoordinatedStorageOptions,
  OpenContext,
  OpenedDatabase,
  OwnedDatabase,
  StorageRole,
} from "./types";

type LockManagerLike = {
  request<T>(
    name: string,
    options: { mode: "exclusive"; signal?: AbortSignal },
    callback: (lock: unknown) => T | PromiseLike<T>,
  ): Promise<T>;
};

type CoordinationHost = {
  navigator?: { locks?: LockManagerLike };
  BroadcastChannel?: BroadcastChannelConstructor;
  document?: unknown;
  importScripts?: unknown;
  addEventListener?: (type: string, listener: (event: { persisted?: boolean }) => void) => void;
  removeEventListener?: (type: string, listener: (event: { persisted?: boolean }) => void) => void;
};

/** What this context currently reads from and writes to. */
export interface StorageView<DB extends BaseDBAdapter<any, any, any>> {
  readonly role: StorageRole;
  readonly dbAdapter: DB;
  readonly mutations: MutationSink;
  /** The outbox of a database this context opened; absent on exclusive followers. */
  readonly localChangeStore?: AtomicLocalChangeStore;
  /** Whether this context commits its own writes and must announce them to other tabs. */
  readonly commitsLocally: boolean;
}

/** Events committed by another context (or by the owner on behalf of a follower). */
export interface ChangeNotice {
  events: ChangeBusEvent<any>[];
  source: "local" | "pull";
}

export interface CoordinatorListener<DB extends BaseDBAdapter<any, any, any>> {
  view?(view: StorageView<DB>): void;
  changes?(notice: ChangeNotice): void;
  /** Notifications may have been missed: re-read everything. */
  invalidate?(): void;
  error?(error: unknown): void;
}

interface OwnedStorage<DB extends BaseDBAdapter<any, any, any>> {
  opened: OpenedDatabase<unknown> &
    Partial<Pick<OwnedDatabase<unknown, unknown, unknown>, "execute">>;
  rawAdapter: DB;
  dbAdapter: DB;
  store: AtomicLocalChangeStore;
  mutex: Mutex;
}

interface Ownership<DB extends BaseDBAdapter<any, any, any>> extends OwnedStorage<DB> {
  epoch: string;
  closing: boolean;
  controller: AbortController;
  requests?: BroadcastChannel;
  replyChannels: Map<string, BroadcastChannel>;
}

const LEASE_TTL_MS = 15_000;
const LEASE_RENEW_MS = 5_000;

function randomId(): string {
  return crypto.randomUUID();
}

function isBrowserContext(host: CoordinationHost): boolean {
  return host.document !== undefined || typeof host.importScripts === "function";
}

function withMutex<DB extends BaseDBAdapter<any, any, any>>(db: DB, mutex: Mutex): DB {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return (fn: never) => mutex.run(() => target.transaction(fn));
      }
      if (property === "commitLocalMutation") {
        return (options: never) => mutex.run(() => target.commitLocalMutation(options));
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function asFollowerAdapter<DB extends BaseDBAdapter<any, any, any>>(db: DB): DB {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction" || property === "commitLocalMutation") {
        return () => Promise.reject(new FollowerWriteError(property));
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/**
 * Elects one storage owner per coordination key and routes this context's storage
 * access accordingly. The owner is also the only context allowed to run sync.
 */
export class StorageCoordinator<
  TDatabase,
  DB extends BaseDBAdapter<any, any, any>,
  Store extends AtomicLocalChangeStore,
> {
  private readonly key: string;
  private readonly lockName: string;
  private readonly sharing: "exclusive" | "shared";
  private readonly listeners = new Set<CoordinatorListener<DB>>();
  private readonly lastSeq = new Map<string, number>();
  private view: StorageView<DB> | undefined;
  private failure: { error: unknown } | undefined;
  private waiters: Array<{ resolve(view: StorageView<DB>): void; reject(error: unknown): void }> =
    [];
  private control: BroadcastChannel | undefined;
  private follower: FollowerClient | undefined;
  private followerView: StorageView<DB> | undefined;
  private ownership: Ownership<DB> | undefined;
  private shared: OwnedStorage<DB> | undefined;
  private lockController: AbortController | undefined;
  private lockReleased: Promise<void> = Promise.resolve();
  private leaseTimer: ReturnType<typeof setInterval> | undefined;
  private leaseToken: number | undefined;
  private leaseValidUntil = 0;
  private sendSeq = 0;
  private disposed = false;
  private pageCleanup: (() => void) | undefined;

  constructor(
    private readonly options: CoordinatedStorageOptions<TDatabase, DB, Store>,
    private readonly host: CoordinationHost = globalThis as CoordinationHost,
    readonly tabId: string = randomId(),
  ) {
    this.key = options.coordinationKey ?? "default";
    this.lockName = `ez-sync:${this.key}`;
    this.sharing = options.sharing ?? "exclusive";
    this.start();
  }

  get role(): StorageRole {
    return this.view?.role ?? "follower";
  }

  /** The current view, once this context knows how to reach the storage. */
  resolve(): Promise<StorageView<DB>> {
    if (this.view) return Promise.resolve(this.view);
    if (this.failure) return Promise.reject(this.failure.error);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  subscribe(listener: CoordinatorListener<DB>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Whether `view` may still write pulled changes and acks (fencing for leases). */
  canCommit(view: StorageView<DB>): boolean {
    if (this.view !== view || view.role !== "owner") return false;
    return this.leaseToken === undefined || Date.now() < this.leaseValidUntil;
  }

  /** Announce events this context committed. Receivers never re-broadcast. */
  broadcastChanges(events: ChangeBusEvent<any>[], source: "local" | "pull", origin = this.tabId) {
    if (!this.control || events.length === 0) return;
    this.post({ t: "changes", sender: this.tabId, seq: ++this.sendSeq, origin, source, events });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.pageCleanup?.();
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.lockController?.abort();
    await this.lockReleased;
    const token = this.leaseToken;
    this.leaseToken = undefined;
    if (token !== undefined) {
      await this.shared?.store.releaseLease?.(this.key, this.tabId, token);
    }
    await this.shared?.opened.close?.();
    this.follower?.dispose();
    this.control?.close();
    this.view = undefined;
    this.fail(new Error("The storage was disposed."));
    this.listeners.clear();
  }

  private start(): void {
    const { host } = this;
    if (this.options.coordinateTabs === false || !isBrowserContext(host)) {
      void this.startStandalone();
      return;
    }
    const locks = host.navigator?.locks;
    const Channel = host.BroadcastChannel;
    if (Channel) {
      this.control = new Channel(controlChannelName(this.key));
      this.control.onmessage = (message: MessageEvent) =>
        this.handleControl(message.data as ControlMessage);
    }
    if (this.sharing === "shared") {
      void this.startShared(locks);
      return;
    }
    if (!locks || !Channel) {
      this.fail(new CoordinationUnavailableError());
      return;
    }
    this.follower = new FollowerClient({
      BroadcastChannel: Channel,
      key: this.key,
      tabId: this.tabId,
      timeoutMs: this.options.requestTimeoutMs ?? 10_000,
      probeOwner: () => this.post({ t: "who-is-owner" }),
    });
    this.watchPageLifecycle(locks);
    this.requestLock(locks);
    this.post({ t: "who-is-owner" });
  }

  private async startStandalone(): Promise<void> {
    try {
      const owned = await this.openOwned({
        epoch: randomId(),
        signal: new AbortController().signal,
      });
      this.shared = owned;
      this.setView(this.ownedView(owned, "owner"));
    } catch (error) {
      this.fail(error);
    }
  }

  private async startShared(locks: LockManagerLike | undefined): Promise<void> {
    try {
      const owned = await this.openOwned({
        epoch: randomId(),
        signal: new AbortController().signal,
      });
      this.shared = owned;
      if (this.disposed) return;
      this.setView(this.ownedView(owned, "follower"));
      if (locks) {
        this.watchPageLifecycle(locks);
        this.requestLock(locks);
      } else if (owned.store.acquireLease && owned.store.supportsCrossContextLeases) {
        void this.renewLease();
        this.leaseTimer = setInterval(() => void this.renewLease(), LEASE_RENEW_MS);
      } else {
        // No way to elect: every context syncs, so providers must accept duplicate pushes.
        this.setRole("owner");
      }
    } catch (error) {
      this.fail(error);
    }
  }

  private async openOwned(context: OpenContext): Promise<OwnedStorage<DB>> {
    const opened = (await this.options.open(context)) as OwnedStorage<DB>["opened"];
    const pair = createAtomicLocalMutationStorage(
      opened.database as TDatabase,
      (database) => this.options.createDBAdapter(database),
      (database) => this.options.createLocalChangeStore(database),
    );
    assertAtomicLocalMutationStorage(pair);
    const mutex = new Mutex();
    return {
      opened,
      rawAdapter: pair.dbAdapter,
      dbAdapter: withMutex(pair.dbAdapter, mutex),
      store: pair.localChangeStore,
      mutex,
    };
  }

  private ownedView(owned: OwnedStorage<DB>, role: StorageRole): StorageView<DB> {
    return {
      role,
      dbAdapter: owned.dbAdapter,
      localChangeStore: owned.store,
      commitsLocally: true,
      mutations: {
        commit: async (mutation) => {
          await executeLocalMutation(owned.dbAdapter, owned.store, mutation);
          await owned.opened.flush?.();
        },
      },
    };
  }

  private getFollowerView(): StorageView<DB> {
    if (!this.followerView) {
      const follower = this.follower!;
      const { connect } = this.options as { connect: (send: unknown) => TDatabase };
      const database = connect((request: unknown) => follower.query(request));
      this.followerView = {
        role: "follower",
        dbAdapter: asFollowerAdapter(this.options.createDBAdapter(database)),
        commitsLocally: false,
        mutations: { commit: (mutation) => follower.mutate(mutation) },
      };
    }
    return this.followerView;
  }

  private setView(view: StorageView<DB>): void {
    if (this.disposed) return;
    this.view = view;
    this.failure = undefined;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.resolve(view);
    for (const listener of this.listeners) listener.view?.(view);
  }

  private setRole(role: StorageRole): void {
    const view = this.view!;
    if (view.role === role) return;
    this.setView({ ...view, role });
  }

  private fail(error: unknown): void {
    if (!this.view) this.failure = { error };
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(error);
    if (!this.disposed) for (const listener of this.listeners) listener.error?.(error);
  }

  private emit(event: "changes", notice: ChangeNotice): void;
  private emit(event: "invalidate"): void;
  private emit(event: "changes" | "invalidate", notice?: ChangeNotice): void {
    for (const listener of this.listeners) {
      if (event === "changes") listener.changes?.(notice!);
      else listener.invalidate?.();
    }
  }

  private post(message: ControlMessage): void {
    this.control?.postMessage(message);
  }

  private requestLock(locks: LockManagerLike): void {
    if (this.lockController || this.disposed) return;
    const controller = new AbortController();
    this.lockController = controller;
    this.lockReleased = locks
      .request(this.lockName, { mode: "exclusive", signal: controller.signal }, async () => {
        // A context that cannot open the database lets the next one try.
        if (!(await this.acquireOwnership(controller.signal))) return;
        if (!controller.signal.aborted) {
          await new Promise<void>((resolve) =>
            controller.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        await this.relinquishOwnership();
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) this.fail(error);
      })
      .finally(() => {
        if (this.lockController === controller) this.lockController = undefined;
      });
  }

  /** Release ownership while the page sits in the back/forward cache; rejoin on return. */
  private watchPageLifecycle(locks: LockManagerLike): void {
    const { addEventListener, removeEventListener } = this.host;
    if (!addEventListener || !removeEventListener) return;
    const onPageHide = () => {
      this.lockController?.abort();
      // A quick pageshow must be able to queue again before the old request settles.
      this.lockController = undefined;
    };
    const onPageShow = (event: { persisted?: boolean }) => {
      if (!event.persisted || this.disposed) return;
      this.requestLock(locks);
      if (this.sharing === "exclusive") this.post({ t: "who-is-owner" });
    };
    addEventListener.call(this.host, "pagehide", onPageHide);
    addEventListener.call(this.host, "pageshow", onPageShow);
    this.pageCleanup = () => {
      removeEventListener.call(this.host, "pagehide", onPageHide);
      removeEventListener.call(this.host, "pageshow", onPageShow);
    };
  }

  private async acquireOwnership(signal: AbortSignal): Promise<boolean> {
    if (this.sharing === "shared") {
      this.setRole("owner");
      return true;
    }
    const epoch = randomId();
    const controller = new AbortController();
    signal.addEventListener("abort", () => controller.abort(), { once: true });
    let owned: OwnedStorage<DB>;
    try {
      owned = await this.openOwned({ epoch, signal: controller.signal });
    } catch (error) {
      this.fail(error);
      return false;
    }
    const ownership: Ownership<DB> = {
      ...owned,
      epoch,
      closing: false,
      controller,
      replyChannels: new Map(),
    };
    this.ownership = ownership;
    const Channel = this.host.BroadcastChannel!;
    ownership.requests = new Channel(ownerChannelName(this.key, epoch));
    ownership.requests.onmessage = (message: MessageEvent) =>
      void this.handleRequest(ownership, message.data as OwnerRequest);
    this.follower!.takeover((body, attempt) => this.executeOwn(ownership, body, attempt));
    this.lastSeq.clear();
    this.setView(this.ownedView(owned, "owner"));
    this.post({ t: "owner-hello", epoch });
    return true;
  }

  private async relinquishOwnership(): Promise<void> {
    if (this.sharing === "shared") {
      this.setRole("follower");
      return;
    }
    const ownership = this.ownership!;
    ownership.closing = true;
    ownership.controller.abort();
    // Let in-flight transactions finish before the engine is persisted and closed.
    await ownership.mutex.run(async () => undefined);
    try {
      await ownership.opened.flush?.();
      await ownership.opened.close?.();
    } finally {
      this.post({ t: "owner-bye", epoch: ownership.epoch });
      ownership.requests?.close();
      for (const channel of ownership.replyChannels.values()) channel.close();
      this.ownership = undefined;
      this.follower!.release();
      if (!this.disposed) this.setView(this.getFollowerView());
    }
  }

  /** Execute a request that originated in this context while it owns the storage. */
  private async executeOwn(
    ownership: Ownership<DB>,
    body: OwnerRequestBody,
    attempt: number,
  ): Promise<unknown> {
    if (body.t === "query") {
      return ownership.mutex.run(() => ownership.opened.execute!(body.request));
    }
    await this.commitOnce(ownership, body.mutation, attempt);
  }

  /**
   * Commit a possibly retried mutation. The check and the commit share one mutex section,
   * so a retry racing the original attempt cannot apply it twice.
   */
  private async commitOnce(
    ownership: Ownership<DB>,
    mutation: LocalMutation,
    attempt: number,
  ): Promise<boolean> {
    const committed = await ownership.mutex.run(async () => {
      if (
        attempt > 1 &&
        (await isLocalMutationCommitted(ownership.rawAdapter, ownership.store, mutation))
      ) {
        return false;
      }
      await executeLocalMutation(ownership.rawAdapter, ownership.store, mutation);
      return true;
    });
    await ownership.opened.flush?.();
    return committed;
  }

  private async handleRequest(ownership: Ownership<DB>, request: OwnerRequest): Promise<void> {
    const reply = (response: OwnerResponse) => this.reply(ownership, request.from, response);
    if (ownership.closing) {
      reply({
        t: "err",
        id: request.id,
        message: "The storage owner is closing.",
        retriable: true,
      });
      return;
    }
    try {
      if (request.t === "query") {
        const result = await ownership.mutex.run(() => ownership.opened.execute!(request.request));
        reply({ t: "ok", id: request.id, result });
        return;
      }
      const mutation = request.mutation;
      if (await this.commitOnce(ownership, mutation, request.attempt)) {
        const events = [toChangeBusEvent(mutation)];
        this.emit("changes", { events, source: "local" });
        this.broadcastChanges(events, "local", request.from);
      }
      reply({ t: "ok", id: request.id });
    } catch (error) {
      reply({
        t: "err",
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
        retriable: false,
      });
    }
  }

  private reply(ownership: Ownership<DB>, tabId: string, response: OwnerResponse): void {
    let channel = ownership.replyChannels.get(tabId);
    if (!channel) {
      channel = new this.host.BroadcastChannel!(tabChannelName(this.key, tabId));
      ownership.replyChannels.set(tabId, channel);
    }
    channel.postMessage(response);
  }

  private handleControl(message: ControlMessage): void {
    switch (message?.t) {
      case "who-is-owner":
        if (this.ownership && !this.ownership.closing) {
          this.post({ t: "owner-hello", epoch: this.ownership.epoch });
        }
        return;
      case "owner-hello":
        if (!this.follower || this.ownership) return;
        if (!this.view) this.setView(this.getFollowerView());
        if (this.follower.setOwner(message.epoch)) {
          this.lastSeq.clear();
          this.emit("invalidate");
        }
        return;
      case "owner-bye":
        this.follower?.clearOwner(message.epoch);
        return;
      case "changes":
        this.handleChanges(message);
        return;
    }
  }

  private handleChanges(message: Extract<ControlMessage, { t: "changes" }>): void {
    const last = this.lastSeq.get(message.sender);
    this.lastSeq.set(message.sender, message.seq);
    if (last !== undefined && message.seq !== last + 1) this.emit("invalidate");
    if (message.origin === this.tabId || message.events.length === 0) return;
    this.emit("changes", { events: message.events, source: message.source });
  }

  private async renewLease(): Promise<void> {
    const store = this.shared!.store;
    try {
      const now = Date.now();
      const token = await store.acquireLease!(this.key, this.tabId, now, LEASE_TTL_MS);
      if (this.disposed) {
        if (token !== undefined) await store.releaseLease?.(this.key, this.tabId, token);
        return;
      }
      if (token === undefined) {
        this.leaseToken = undefined;
        this.setRole("follower");
        return;
      }
      this.leaseToken = token;
      this.leaseValidUntil = now + LEASE_TTL_MS;
      this.setRole("owner");
    } catch (error) {
      this.leaseToken = undefined;
      this.setRole("follower");
      this.fail(error);
    }
  }
}
