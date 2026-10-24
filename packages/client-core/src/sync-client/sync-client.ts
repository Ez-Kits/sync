import type {
  ChangeBus,
  ChangeBusEvent,
  ChangeBusEventDataMapFromCollectionConfigMap,
} from "../change-bus";
import {
  CollectionRuntime,
  type CollectionConfigMap,
  type CollectionNames,
  type TCollectionRuntimeRecord,
} from "../collection";
import type { BaseDBAdapter } from "../db-adapter";
import type { ILocalChangeStore } from "../local-change-store";
import type { AtomicLocalChangeStore } from "../local-change-store";
import { SyncHandler } from "../sync-handler";
import type { LiveQueryFn, SubscribeFn, SyncClient, SyncClientConfig } from "./types";
import type { SyncStatusEvent } from "../sync-handler";
import { assertAtomicLocalMutationStorage } from "./storage-pair";

type NetworkHost = {
  navigator?: { onLine?: boolean };
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

function getNetworkHost(): NetworkHost {
  return globalThis as NetworkHost;
}

function isBrowserNetworkAvailable(): boolean {
  const { navigator: networkNavigator } = getNetworkHost();
  if (!networkNavigator) return true;
  return networkNavigator.onLine !== false;
}

export class SyncClientImpl<
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
  Store extends AtomicLocalChangeStore,
> implements SyncClient<C, DB, TCheckpoint> {
  readonly collections: TCollectionRuntimeRecord<C>;
  private readonly db: DB;
  private syncHandler: SyncHandler<C, DB, TCheckpoint>;
  private wantsSync = false;
  private networkCleanup: (() => void) | undefined;
  private status: SyncStatusEvent = { status: "stopped", changedAt: Date.now() };
  private statusListeners = new Set<(event: SyncStatusEvent) => void>();
  private readonly localChangeStore: ILocalChangeStore;
  private readonly leaseOwner = `sync-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  private leaseToken: number | undefined;
  private leaseTimer: ReturnType<typeof setInterval> | undefined;
  private broadcastChannel: BroadcastChannel | undefined;
  private broadcastCleanup: (() => void) | undefined;

  constructor(
    private config: SyncClientConfig<C, DB, TCheckpoint, Store>,
    private changeBus: ChangeBus<ChangeBusEventDataMapFromCollectionConfigMap<C>>,
  ) {
    assertAtomicLocalMutationStorage(config.storage);
    const localChangeStore = config.storage.localChangeStore;
    const db = config.storage.dbAdapter;
    this.db = db;
    this.localChangeStore = localChangeStore;

    this.syncHandler = new SyncHandler<C, DB, TCheckpoint>({
      collections: config.collections,
      db: this.db,
      changeBus: this.changeBus,
      checkpointStorage: config.checkpointStorage,
      localChangeStore,
      syncAdapter: config.syncAdapter,
      onSyncError: (error) => this.setStatus("error", error),
      onSyncSuccess: () => this.setStatus("syncing"),
      conflictResolver: config.resolveConflict,
    });

    this.collections = Object.fromEntries(
      config.collections.map((col) => [
        col.name,
        new CollectionRuntime(col, this.db, this.changeBus, localChangeStore),
      ]),
    ) as unknown as TCollectionRuntimeRecord<C>;

    if (typeof BroadcastChannel !== "undefined") {
      const key = config.coordinationKey ?? "default";
      this.broadcastChannel = new BroadcastChannel(`ez-sync:${key}`);
      this.broadcastChannel.onmessage = (message: MessageEvent) => {
        const payload = message.data as { type?: string; events?: ChangeBusEvent<any>[] };
        if (payload?.type === "local-change" && Array.isArray(payload.events)) {
          this.changeBus.publishRemoteBatch(payload.events);
        }
      };
      this.broadcastCleanup = this.changeBus.subscribe(
        (events) => this.broadcastChannel?.postMessage({ type: "local-change", events }),
        { stream: "local" },
      );
    }
  }

  subscribe: SubscribeFn<C> = (...args: unknown[]) => {
    type DataMap = ChangeBusEventDataMapFromCollectionConfigMap<C>;
    if (args.length === 1 && typeof args[0] === "function") {
      return this.changeBus.subscribe(
        args[0] as (events: ChangeBusEvent<DataMap, keyof DataMap>[]) => void,
      );
    }
    if (args.length === 2 && typeof args[0] === "function" && typeof args[1] === "object") {
      return this.changeBus.subscribe(
        args[0] as (events: ChangeBusEvent<DataMap, keyof DataMap>[]) => void,
        args[1] as { stream?: "local" | "remote" | "both" },
      );
    }
    if (args.length === 2 || args.length === 3) {
      const [collectionOrCollections, cb] = args as [
        CollectionNames<C> | readonly CollectionNames<C>[],
        (events: ChangeBusEvent<DataMap, keyof DataMap>[]) => void,
      ];
      const options = (args[2] ?? undefined) as
        | { stream?: "local" | "remote" | "both" }
        | undefined;
      if (Array.isArray(collectionOrCollections)) {
        return this.changeBus.subscribe(
          collectionOrCollections as readonly CollectionNames<C>[],
          cb as (events: ChangeBusEvent<DataMap, keyof DataMap>[]) => void,
          options,
        );
      }
      return this.changeBus.subscribe(
        collectionOrCollections as CollectionNames<C>,
        cb as (events: ChangeBusEvent<DataMap, keyof DataMap>[]) => void,
        options,
      );
    }
    throw new TypeError(
      "subscribe: expected (cb[, options]), (collection, cb[, options]), or (collections, cb[, options])",
    );
  };

  liveQuery: LiveQueryFn<C, DB> = (options) => {
    const { collections, query, onData } = options;
    const queryBuilder = this.db.queryBuilder;
    const querySchema = this.db.querySchema;

    const triggerQuery = async () => {
      const queryResult = await query(queryBuilder, querySchema);
      onData(queryResult);
    };

    void triggerQuery();

    if (collections) {
      return this.changeBus.subscribe(collections, triggerQuery);
    }

    return this.changeBus.subscribe(triggerQuery);
  };

  getCheckpoint = async <N extends CollectionNames<C>>(collection: N) => {
    return this.config.checkpointStorage.getCheckpoint(collection);
  };

  saveCheckpoint = async <N extends CollectionNames<C>>(collection: N, checkpoint: TCheckpoint) => {
    await this.config.checkpointStorage.saveCheckpoint(collection, checkpoint);
  };

  startSync = () => {
    this.wantsSync = true;
    this.attachNetworkListeners();
    if (isBrowserNetworkAvailable()) {
      this.setStatus("starting");
      this.startLeadership();
    } else {
      this.setStatus("offline");
    }
  };

  stopSync = () => {
    this.wantsSync = false;
    this.detachNetworkListeners();
    this.stopLeadership();
    this.setStatus("stopped");
  };

  dispose = () => {
    this.stopSync();
    this.broadcastCleanup?.();
    this.broadcastCleanup = undefined;
    this.broadcastChannel?.close();
    this.broadcastChannel = undefined;
    this.statusListeners.clear();
  };

  subscribeStatus = (listener: (event: SyncStatusEvent) => void) => {
    this.statusListeners.add(listener);
    try {
      listener(this.status);
    } catch {
      // A status observer cannot interrupt client construction or subscription.
    }
    return () => this.statusListeners.delete(listener);
  };

  private setStatus(status: SyncStatusEvent["status"], error?: unknown): void {
    this.status = { status, error, changedAt: Date.now() };
    try {
      this.config.onSyncStatus?.(this.status);
    } catch {
      // Application observers must not interrupt sync lifecycle transitions.
    }
    for (const listener of this.statusListeners) {
      try {
        listener(this.status);
      } catch {
        // One observer must not block delivery to other observers.
      }
    }
  }

  private startLeadership(): void {
    const browserClient = Boolean(getNetworkHost().navigator);
    if (
      this.config.coordinateTabs === false ||
      !browserClient ||
      !this.localChangeStore.acquireLease ||
      !this.localChangeStore.supportsCrossContextLeases
    ) {
      this.syncHandler.startAll();
      this.setStatus("syncing");
      return;
    }

    if (!this.leaseTimer) {
      void this.renewLeadership();
      this.leaseTimer = setInterval(() => void this.renewLeadership(), 5_000);
    }
  }

  private async renewLeadership(): Promise<void> {
    if (!this.wantsSync || !isBrowserNetworkAvailable()) return;
    try {
      const token = await this.localChangeStore.acquireLease!(
        this.config.coordinationKey ?? "default",
        this.leaseOwner,
        Date.now(),
        15_000,
      );
      if (!this.wantsSync || !isBrowserNetworkAvailable()) {
        if (token !== undefined) {
          await this.localChangeStore.releaseLease?.(
            this.config.coordinationKey ?? "default",
            this.leaseOwner,
            token,
          );
        }
        return;
      }
      if (token === undefined) {
        if (this.leaseToken !== undefined) this.syncHandler.stopAll();
        this.leaseToken = undefined;
        this.setStatus("idle");
        return;
      }
      this.leaseToken = token;
      this.syncHandler.startAll();
      this.setStatus("syncing");
    } catch (error) {
      this.syncHandler.stopAll();
      this.leaseToken = undefined;
      this.setStatus("error", error);
    }
  }

  private stopLeadership(): void {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = undefined;
    this.syncHandler.stopAll();
    const token = this.leaseToken;
    this.leaseToken = undefined;
    if (token !== undefined) {
      void this.localChangeStore.releaseLease?.(
        this.config.coordinationKey ?? "default",
        this.leaseOwner,
        token,
      );
    }
  }

  private attachNetworkListeners(): void {
    const host = getNetworkHost();
    if (this.networkCleanup || !host.addEventListener || !host.removeEventListener) {
      return;
    }

    const onOnline = () => {
      if (!this.wantsSync) return;
      this.setStatus("starting");
      this.startLeadership();
    };
    const onOffline = () => {
      this.stopLeadership();
      this.setStatus("offline");
    };

    host.addEventListener("online", onOnline);
    host.addEventListener("offline", onOffline);
    this.networkCleanup = () => {
      host.removeEventListener?.("online", onOnline);
      host.removeEventListener?.("offline", onOffline);
    };
  }

  private detachNetworkListeners(): void {
    this.networkCleanup?.();
    this.networkCleanup = undefined;
  }
}
