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
import type { AtomicLocalChangeStore } from "../local-change-store";
import type { StorageRole } from "../storage-coordination";
import { getStorageCoordinator } from "../storage-coordination/coordinated-storage";
import type { StorageCoordinator, StorageView } from "../storage-coordination/coordinator";
import { SyncHandler } from "../sync-handler";
import type { LiveQueryFn, SubscribeFn, SyncClient, SyncClientConfig } from "./types";
import type { SyncStatusEvent } from "../sync-handler";

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
  private readonly coordinator: StorageCoordinator<unknown, DB, Store>;
  private view: StorageView<DB> | undefined;
  private syncHandler: SyncHandler<C, DB, TCheckpoint> | undefined;
  private wantsSync = false;
  private networkCleanup: (() => void) | undefined;
  private status: SyncStatusEvent = { status: "stopped", changedAt: Date.now() };
  private statusListeners = new Set<(event: SyncStatusEvent) => void>();
  private roleListeners = new Set<(role: StorageRole) => void>();
  private liveQueries = new Set<() => void>();
  private cleanups: Array<() => void> = [];

  constructor(
    private config: SyncClientConfig<C, DB, TCheckpoint, Store>,
    private changeBus: ChangeBus<ChangeBusEventDataMapFromCollectionConfigMap<C>>,
  ) {
    this.coordinator = getStorageCoordinator(config.storage);

    this.collections = Object.fromEntries(
      config.collections.map((col) => [
        col.name,
        new CollectionRuntime(col, this.coordinator, this.changeBus),
      ]),
    ) as unknown as TCollectionRuntimeRecord<C>;

    this.cleanups.push(
      this.coordinator.subscribe({
        view: (view) => this.applyView(view),
        changes: ({ events, source }) => {
          this.changeBus.publishRemoteBatch(events);
          // Another context committed these to the outbox this owner pushes from.
          if (source === "local") {
            this.syncHandler?.notifyOutboxChanged(
              events.map((event) => event.collection as CollectionNames<C>),
            );
          }
        },
        invalidate: () => {
          for (const rerun of this.liveQueries) rerun();
        },
        error: (error) => this.setStatus("error", error),
      }),
      this.changeBus.subscribe(
        (events) => {
          if (this.view?.commitsLocally) this.coordinator.broadcastChanges(events, "local");
        },
        { stream: "local" },
      ),
    );
    void this.coordinator.resolve().then(
      (view) => this.applyView(view),
      (error: unknown) => this.setStatus("error", error),
    );
  }

  get storageRole(): StorageRole {
    return this.coordinator.role;
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

    // Resolve the adapter per run: a follower's proxy is replaced on promotion.
    const triggerQuery = async () => {
      const { dbAdapter } = await this.coordinator.resolve();
      const queryResult = await query(dbAdapter.queryBuilder, dbAdapter.querySchema);
      onData(queryResult);
    };
    const rerun = () => void triggerQuery();

    rerun();
    this.liveQueries.add(rerun);

    const unsubscribe = collections
      ? this.changeBus.subscribe(collections, rerun)
      : this.changeBus.subscribe(rerun);
    return () => {
      this.liveQueries.delete(rerun);
      unsubscribe();
    };
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
      this.reconcileSync();
    } else {
      this.setStatus("offline");
    }
  };

  stopSync = () => {
    this.wantsSync = false;
    this.detachNetworkListeners();
    this.syncHandler?.stopAll();
    this.setStatus("stopped");
  };

  dispose = async () => {
    this.stopSync();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    this.liveQueries.clear();
    this.statusListeners.clear();
    this.roleListeners.clear();
    await this.coordinator.dispose();
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

  subscribeStorageRole = (listener: (role: StorageRole) => void) => {
    this.roleListeners.add(listener);
    try {
      listener(this.storageRole);
    } catch {
      // A role observer cannot interrupt subscription.
    }
    return () => this.roleListeners.delete(listener);
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

  /** Track the storage view; only an owner view gets a sync handler. */
  private applyView(view: StorageView<DB>): void {
    if (this.view === view) return;
    const previousView = this.view;
    const previousRole = previousView?.role ?? "follower";
    const adapterChanged = this.view?.dbAdapter !== view.dbAdapter;
    this.view = view;

    if (view.role !== "owner" || adapterChanged || !this.syncHandler) {
      this.syncHandler?.stopAll();
      this.syncHandler = view.role === "owner" ? this.createSyncHandler(view) : undefined;
    }
    // Queries already ran against the first view; rerun only when the adapter is replaced.
    if (adapterChanged && previousView) {
      for (const rerun of this.liveQueries) rerun();
    }
    if (previousRole !== view.role) {
      for (const listener of this.roleListeners) {
        try {
          listener(view.role);
        } catch {
          // One observer must not block delivery to other observers.
        }
      }
    }
    if (this.wantsSync && isBrowserNetworkAvailable()) this.reconcileSync();
  }

  private createSyncHandler(view: StorageView<DB>): SyncHandler<C, DB, TCheckpoint> {
    return new SyncHandler<C, DB, TCheckpoint>({
      collections: this.config.collections,
      db: view.dbAdapter,
      changeBus: this.changeBus,
      checkpointStorage: this.config.checkpointStorage,
      localChangeStore: view.localChangeStore!,
      syncAdapter: this.config.syncAdapter,
      onSyncError: (error) => this.setStatus("error", error),
      onSyncSuccess: () => this.setStatus("syncing"),
      conflictResolver: this.config.resolveConflict,
      onRemoteChangesCommitted: (changes) => this.coordinator.broadcastChanges(changes, "pull"),
      canCommit: () => this.coordinator.canCommit(view),
    });
  }

  private reconcileSync(): void {
    if (!this.view) return;
    if (!this.syncHandler) {
      this.setStatus("idle");
      return;
    }
    this.syncHandler.startAll();
    this.setStatus("syncing");
  }

  private attachNetworkListeners(): void {
    const host = getNetworkHost();
    if (this.networkCleanup || !host.addEventListener || !host.removeEventListener) {
      return;
    }

    // Listeners exist only while sync is wanted (attached in startSync, removed in stopSync).
    const onOnline = () => {
      this.setStatus("starting");
      this.reconcileSync();
    };
    // Going offline pauses sync but keeps storage ownership.
    const onOffline = () => {
      this.syncHandler?.stopAll();
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
