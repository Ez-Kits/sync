import type {
  ChangeBus,
  ChangeBusEvent,
  ChangeBusEventDataMapFromCollectionConfigMap,
} from "../change-bus";
import { isTransactionalCheckpointStorage } from "../checkpoint-storage";
import {
  CollectionRuntime,
  type CollectionConfigMap,
  type CollectionNames,
  type CollectionRuntimeStorage,
  type TCollectionRuntimeRecord,
} from "../collection";
import {
  executeLocalMutation,
  isLocalMutationCommitted,
  type LocalMutation,
  type MutationSink,
} from "../collection/local-mutation";
import type { BaseDBAdapter } from "../db-adapter";
import { isRetriableError, type DBRole, type DBStorage } from "../db-storage";
import { SyncHandler } from "../sync-handler";
import type { SyncStatusEvent } from "../sync-handler";
import { SyncTabChannel } from "./tab-channel";
import type { LiveQueryFn, SubscribeFn, SyncClient, SyncClientConfig } from "./types";

type NetworkHost = {
  navigator?: { onLine?: boolean };
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

/** Attempts per local mutation when the leader changes mid-commit. */
const MAX_COMMIT_ATTEMPTS = 3;

function getNetworkHost(): NetworkHost {
  return globalThis as NetworkHost;
}

function isBrowserNetworkAvailable(): boolean {
  const { navigator: networkNavigator } = getNetworkHost();
  if (!networkNavigator) return true;
  return networkNavigator.onLine !== false;
}

function assertDBAdapter(dbAdapter: BaseDBAdapter<any, any, any> | undefined): void {
  if (
    typeof dbAdapter?.commitLocalMutation !== "function" ||
    typeof dbAdapter.dbStorage?.transaction !== "function" ||
    dbAdapter.localChangeStore?.atomicLocalMutationCapability !== "atomic" ||
    typeof dbAdapter.localChangeStore.initialize !== "function"
  ) {
    throw new Error(
      "Sync clients require a database adapter with a DB storage and an atomic local-change store.",
    );
  }
}

export class SyncClientImpl<
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> implements SyncClient<C, DB, TCheckpoint> {
  readonly collections: TCollectionRuntimeRecord<C>;
  private readonly dbAdapter: DB;
  private readonly dbStorage: DBStorage;
  private readonly tabs: SyncTabChannel;
  private appliedRole: DBRole | undefined;
  /** Storage ready and local-change store initialized; nothing touches the database before. */
  private readonly initialized: Promise<void>;
  private isInitialized = false;
  private syncHandler: SyncHandler<C, DB, TCheckpoint> | undefined;
  private wantsSync = false;
  private networkCleanup: (() => void) | undefined;
  private status: SyncStatusEvent = { status: "stopped", changedAt: Date.now() };
  private statusListeners = new Set<(event: SyncStatusEvent) => void>();
  private roleListeners = new Set<(role: DBRole) => void>();
  private liveQueries = new Set<() => void>();
  private cleanups: Array<() => void> = [];

  constructor(
    private config: SyncClientConfig<C, DB, TCheckpoint>,
    private changeBus: ChangeBus<ChangeBusEventDataMapFromCollectionConfigMap<C>>,
  ) {
    assertDBAdapter(config.dbAdapter);
    const { checkpointStorage } = config;
    if (
      isTransactionalCheckpointStorage(checkpointStorage) &&
      checkpointStorage.localChangeStore !== config.dbAdapter.localChangeStore
    ) {
      // Its transactions would not be the adapter's: the checkpoint could not commit with its rows.
      throw new Error(
        "The DB checkpoint storage must use the local-change store of the sync client's adapter.",
      );
    }
    this.dbAdapter = config.dbAdapter;
    this.dbStorage = config.dbAdapter.dbStorage;
    this.tabs = new SyncTabChannel(this.dbStorage.key);

    const mutations: MutationSink = { commit: (mutation) => this.commitMutation(mutation) };
    const storage: CollectionRuntimeStorage = {
      resolve: async () => {
        await this.initialized;
        return { dbAdapter: this.dbAdapter, mutations };
      },
    };
    this.collections = Object.fromEntries(
      config.collections.map((col) => [col.name, new CollectionRuntime(col, storage, changeBus)]),
    ) as unknown as TCollectionRuntimeRecord<C>;

    this.cleanups.push(
      // Before initialization, the current role is applied once it completes.
      this.dbStorage.onRoleChange((role) => {
        if (this.isInitialized) this.applyRole(role);
      }),
      this.dbStorage.onInvalidate(() => {
        this.tabs.reset();
        this.rerunLiveQueries();
        // A new leader does not know this context wants sync.
        if (this.wantsSync && this.appliedRole === "follower") this.tabs.requestSync();
      }),
      this.dbStorage.onError((error) => this.setStatus("error", error)),
      this.tabs.subscribe({
        changes: ({ events, source }) => {
          this.changeBus.publishRemoteBatch(events);
          // Another context committed these to the outbox the leader pushes from.
          if (source === "local") {
            this.syncHandler?.notifyOutboxChanged(
              events.map((event) => event.collection as CollectionNames<C>),
            );
          }
        },
        invalidate: () => this.rerunLiveQueries(),
        syncRequest: () => {
          if (this.appliedRole === "leader" && !this.wantsSync) this.startSync();
        },
      }),
      this.changeBus.subscribe((events) => this.tabs.broadcastChanges(events, "local"), {
        stream: "local",
      }),
    );
    this.initialized = this.dbStorage.ready.then(() =>
      this.dbAdapter.localChangeStore.initialize(),
    );
    void this.initialized.then(
      () => {
        this.isInitialized = true;
        this.applyRole(this.dbStorage.role);
      },
      (error: unknown) => this.setStatus("error", error),
    );
  }

  get role(): DBRole {
    return this.appliedRole ?? "follower";
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

    const triggerQuery = async () => {
      await this.initialized;
      const queryResult = await query(this.dbAdapter.queryBuilder, this.dbAdapter.querySchema);
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
    if (this.appliedRole === "follower") this.tabs.requestSync();
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

  retryRejectedPushes = () => {
    this.syncHandler?.retryRejectedPushes();
  };

  dispose = async () => {
    this.stopSync();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    this.tabs.close();
    this.liveQueries.clear();
    this.statusListeners.clear();
    this.roleListeners.clear();
    await this.dbStorage.close();
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

  subscribeRole = (listener: (role: DBRole) => void) => {
    this.roleListeners.add(listener);
    try {
      listener(this.role);
    } catch {
      // A role observer cannot interrupt subscription.
    }
    return () => this.roleListeners.delete(listener);
  };

  /**
   * Commit through the adapter. A leader change aborts the transaction; retry it on the
   * next leader unless the first attempt already reached the database.
   */
  private async commitMutation(mutation: LocalMutation): Promise<void> {
    const { localChangeStore } = this.dbAdapter;
    for (let attempt = 1; ; attempt += 1) {
      try {
        if (attempt > 1 && (await isLocalMutationCommitted(localChangeStore, mutation))) {
          return;
        }
        await executeLocalMutation(this.dbAdapter, localChangeStore, mutation);
        return;
      } catch (error) {
        if (!isRetriableError(error) || attempt >= MAX_COMMIT_ATTEMPTS) throw error;
      }
    }
  }

  private rerunLiveQueries(): void {
    for (const rerun of this.liveQueries) rerun();
  }

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

  /** Only the leader gets a sync handler. */
  private applyRole(role: DBRole): void {
    if (this.appliedRole === role) return;
    const previousRole = this.role;
    this.appliedRole = role;
    this.syncHandler?.stopAll();
    this.syncHandler = role === "leader" ? this.createSyncHandler() : undefined;
    if (previousRole !== role) {
      for (const listener of this.roleListeners) {
        try {
          listener(role);
        } catch {
          // One observer must not block delivery to other observers.
        }
      }
    }
    if (this.wantsSync && role === "follower") this.tabs.requestSync();
    if (this.wantsSync && isBrowserNetworkAvailable()) this.reconcileSync();
  }

  private createSyncHandler(): SyncHandler<C, DB, TCheckpoint> {
    const handler: SyncHandler<C, DB, TCheckpoint> = new SyncHandler<C, DB, TCheckpoint>({
      collections: this.config.collections,
      db: this.dbAdapter,
      changeBus: this.changeBus,
      checkpointStorage: this.config.checkpointStorage,
      localChangeStore: this.dbAdapter.localChangeStore,
      syncAdapter: this.config.syncAdapter,
      onSyncError: (error) => this.setStatus("error", error),
      onSyncSuccess: () => this.setStatus("syncing"),
      conflictResolver: this.config.resolveConflict,
      onRemoteChangesCommitted: (changes) => this.tabs.broadcastChanges(changes, "pull"),
      onPushRejected: (rejection) => {
        try {
          this.config.onPushRejected?.(rejection);
        } catch {
          // An application observer must not fail the push that reported the rejection.
        }
      },
      canCommit: () => this.syncHandler === handler && this.dbStorage.role === "leader",
    });
    return handler;
  }

  private reconcileSync(): void {
    if (!this.appliedRole) return;
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
    // Going offline pauses sync but keeps leadership.
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
