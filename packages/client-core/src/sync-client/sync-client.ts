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
import { createLocalChangeStore } from "../local-change-store";
import { SyncHandler } from "../sync-handler";
import type { LiveQueryFn, SubscribeFn, SyncClient, SyncClientConfig } from "./types";

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
> implements SyncClient<C, DB, TCheckpoint> {
  readonly collections: TCollectionRuntimeRecord<C>;
  private syncHandler: SyncHandler<C, DB, TCheckpoint>;
  private wantsSync = false;
  private networkCleanup: (() => void) | undefined;

  constructor(
    private config: SyncClientConfig<C, DB, TCheckpoint>,
    private db: DB,
    private changeBus: ChangeBus<ChangeBusEventDataMapFromCollectionConfigMap<C>>,
  ) {
    const localChangeStore = createLocalChangeStore();

    this.syncHandler = new SyncHandler<C, DB, TCheckpoint>({
      collections: config.collections,
      db: this.db,
      changeBus: this.changeBus,
      checkpointStorage: config.checkpointStorage,
      localChangeStore,
      sync: config.sync,
    });

    this.collections = Object.fromEntries(
      config.collections.map((col) => [
        col.name,
        new CollectionRuntime(col, this.db, this.changeBus, localChangeStore),
      ]),
    ) as unknown as TCollectionRuntimeRecord<C>;
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
      this.syncHandler.startAll();
    }
  };

  stopSync = () => {
    this.wantsSync = false;
    this.detachNetworkListeners();
    this.syncHandler.stopAll();
  };

  private attachNetworkListeners(): void {
    const host = getNetworkHost();
    if (this.networkCleanup || !host.addEventListener || !host.removeEventListener) {
      return;
    }

    const onOnline = () => {
      if (!this.wantsSync) return;
      this.syncHandler.startAll();
    };
    const onOffline = () => {
      this.syncHandler.stopAll();
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
