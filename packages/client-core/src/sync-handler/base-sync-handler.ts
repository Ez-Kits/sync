import type {
  ChangeBus,
  ChangeBusEvent,
  ChangeBusEventDataMapFromCollectionConfigMap,
} from "../change-bus";
import type { ICheckpointStorage } from "../checkpoint-storage";
import type { CollectionConfigMap, CollectionNames, ConfigForName } from "../collection";
import type { BaseDBAdapter, DBAdapterOperations } from "../db-adapter";
import type { DirtyRecordState, ILocalChangeStore } from "../local-change-store";
import type { SyncAdapter } from "./types";
import type { ConflictResolution } from "./types";

export type SyncHandlerDataMap<C extends CollectionConfigMap> =
  ChangeBusEventDataMapFromCollectionConfigMap<C>;

export interface BaseSyncHandlerConfig<
  C extends CollectionConfigMap<TCheckpoint>,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> {
  collections: C;
  db: DB;
  changeBus: ChangeBus<SyncHandlerDataMap<C>>;
  checkpointStorage: ICheckpointStorage<CollectionNames<C>, TCheckpoint>;
  localChangeStore: ILocalChangeStore;
  onSyncError?: (error: unknown) => void;
  onSyncSuccess?: () => void;
  conflictResolver?: ConflictResolution<SyncHandlerDataMap<C>>;
}

export abstract class BaseSyncHandler<
  C extends CollectionConfigMap<TCheckpoint>,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
> {
  protected readonly collectionMap: Map<CollectionNames<C>, C[number]>;
  private pushQueues = new Map<string, Promise<void>>();

  constructor(protected readonly config: BaseSyncHandlerConfig<C, DB, TCheckpoint>) {
    this.collectionMap = new Map(
      config.collections.map((collection) => [collection.name, collection]),
    );
  }

  /** Serialize provider pushes and retry failures without acknowledging events. */
  protected enqueuePush(
    key: string,
    push: () => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const previous = this.pushQueues.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        let delayMs = 250;
        while (!signal?.aborted) {
          try {
            await push();
            this.config.onSyncSuccess?.();
            return;
          } catch (error) {
            if (signal?.aborted) return;
            this.config.onSyncError?.(error);
            if (!(await waitOrAbort(delayMs, signal))) return;
            delayMs = Math.min(delayMs * 2, 8_000);
          }
        }
      });
    this.pushQueues.set(key, next);
    void next.finally(() => {
      if (this.pushQueues.get(key) === next) this.pushQueues.delete(key);
    });
    return next;
  }

  /** Keep a pull listener alive across provider errors while retaining checkpoint safety. */
  protected retryPull(
    subscribe: (
      onError: (error: unknown) => void,
      isActive: () => boolean,
    ) => void | (() => void) | Promise<void | (() => void)>,
  ): () => void {
    let active = true;
    let connecting = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let currentCleanup: (() => void) | undefined;
    let retryDelayMs = 250;

    const scheduleRetry = (error: unknown) => {
      if (!active) return;
      this.config.onSyncError?.(error);
      const cleanup = currentCleanup;
      currentCleanup = undefined;
      cleanup?.();
      if (!active || retryTimer !== undefined) return;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void connect();
      }, retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, 8_000);
    };

    const connect = async () => {
      if (!active || connecting) return;
      connecting = true;
      const cleanup = currentCleanup;
      currentCleanup = undefined;
      cleanup?.();
      try {
        const unsubscribe = await subscribe(scheduleRetry, () => active);
        if (active) {
          if (typeof unsubscribe === "function") currentCleanup = unsubscribe;
          retryDelayMs = 250;
          this.config.onSyncSuccess?.();
        } else {
          unsubscribe?.();
        }
      } catch (error) {
        scheduleRetry(error);
      } finally {
        connecting = false;
      }
    };

    void connect();
    return () => {
      active = false;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      currentCleanup?.();
      currentCleanup = undefined;
    };
  }

  protected async applyEvent<N extends CollectionNames<C>>(
    collectionName: N,
    event: ChangeBusEvent<SyncHandlerDataMap<C>, N>,
    db: DBAdapterOperations<C> = this.config.db,
  ): Promise<void> {
    const collectionConfig = this.collectionMap.get(collectionName) as
      | ConfigForName<C, N>
      | undefined;
    if (!collectionConfig) return;

    if (event.type === "delete") {
      await db.delete(collectionName, event.id as never);
      return;
    }

    await this.upsertRow(
      collectionName,
      collectionConfig,
      event.data as Record<string, unknown>,
      db,
    );
  }

  protected async applyAnyCollectionEvent(
    event: ChangeBusEvent<SyncHandlerDataMap<C>>,
    db: DBAdapterOperations<C> = this.config.db,
  ): Promise<void> {
    await this.applyEvent(event.collection as CollectionNames<C>, event as never, db);
  }

  /** Apply the configured conflict hook only when this record has local pending writes. */
  protected async resolveRemoteEvent(
    event: ChangeBusEvent<SyncHandlerDataMap<C>>,
  ): Promise<ChangeBusEvent<SyncHandlerDataMap<C>> | undefined> {
    const resolver = this.config.conflictResolver;
    if (!resolver) return event;
    const collection = event.collection as CollectionNames<C>;
    const primaryField = this.primaryFieldName(collection);
    const recordId = String(
      event.type === "delete" ? event.id : (event.data as Record<string, unknown>)[primaryField],
    );
    const [dirty, pending] = await Promise.all([
      this.config.localChangeStore.getDirtyRecords(String(collection)),
      this.config.localChangeStore.getPendingEvents(String(collection)),
    ]);
    if (
      !dirty.some((record) => record.recordId === recordId) &&
      !pending.some((record) => record.recordId === recordId)
    ) {
      return event;
    }

    let local: SyncHandlerDataMap<C>[CollectionNames<C>]["record"] | undefined;
    local = this.config.db.getOptional
      ? await this.config.db.getOptional(collection, coerceRecordId(recordId) as never)
      : await this.config.db.get(collection, coerceRecordId(recordId) as never);
    const resolution = await resolver({ remote: event, local });
    if (resolution === "local") return undefined;
    if (resolution === "remote") return event;
    if (event.type === "delete") {
      return {
        type: "update",
        collection: event.collection,
        data: resolution.data,
      } as ChangeBusEvent<SyncHandlerDataMap<C>>;
    }
    return { ...event, data: resolution.data } as ChangeBusEvent<SyncHandlerDataMap<C>>;
  }

  /**
   * Build push events from pending ChangeBusEvents persisted in the local change store.
   * Used on sync start to flush changes made while offline / before sync.
   */
  protected async collectPendingPushEvents<N extends CollectionNames<C>>(
    collectionName: N,
  ): Promise<ChangeBusEvent<SyncHandlerDataMap<C>, N>[]> {
    const storedEvents = await this.config.localChangeStore.getPendingEvents(
      String(collectionName),
    );

    return storedEvents.map((stored) => {
      if (stored.type === "delete") {
        return {
          type: "delete",
          collection: collectionName,
          id: coerceRecordId(stored.recordId),
          deletedAt: stored.createdAt,
          eventId: stored.id,
        } as ChangeBusEvent<SyncHandlerDataMap<C>, N>;
      }

      return {
        type: stored.type,
        collection: collectionName,
        data: stored.data,
        eventId: stored.id,
      } as ChangeBusEvent<SyncHandlerDataMap<C>, N>;
    });
  }

  protected async collectAllPendingPushEvents(): Promise<ChangeBusEvent<SyncHandlerDataMap<C>>[]> {
    const batches = await Promise.all(
      this.config.collections.map((collection) =>
        this.collectPendingPushEvents(collection.name as CollectionNames<C>),
      ),
    );
    return batches.flat();
  }

  protected async flushPendingPushEvents<N extends CollectionNames<C>>(
    collectionName: N,
    syncAdapter: SyncAdapter<SyncHandlerDataMap<C>, N, TCheckpoint>,
    commitPushChanges: (events: ChangeBusEvent<SyncHandlerDataMap<C>, N>[]) => Promise<void>,
    queueKey = String(collectionName),
    signal?: AbortSignal,
  ): Promise<void> {
    await this.enqueuePush(
      queueKey,
      async () => {
        const events = await this.collectPendingPushEvents(collectionName);
        if (events.length === 0) return;
        await syncAdapter.push({
          events,
          commitChanges: ({ events: committedEvents }) => {
            void commitPushChanges(committedEvents);
          },
        });
      },
      signal,
    );
  }

  /**
   * After a successful push, remove acked events from the local store and refresh dirty tracking.
   */
  protected async ackPushedEvents(events: ChangeBusEvent<SyncHandlerDataMap<C>>[]): Promise<void> {
    const eventIds = events
      .map((event) => event.eventId)
      .filter((eventId): eventId is string => typeof eventId === "string");

    if (eventIds.length > 0) {
      await this.config.localChangeStore.deleteEvents(eventIds);
    }

    const affectedKeys = new Map<string, { collection: string; recordId: string }>();
    for (const event of events) {
      const collection = String(event.collection);
      const recordId =
        event.type === "delete"
          ? String(event.id)
          : String(
              (event.data as Record<string, unknown>)[this.primaryFieldName(event.collection)],
            );
      affectedKeys.set(`${collection}\0${recordId}`, { collection, recordId });
    }

    const keysToRemove: Array<{ collection: string; recordId: string }> = [];
    for (const key of affectedKeys.values()) {
      const remaining = (
        await this.config.localChangeStore.getPendingEvents(key.collection)
      ).filter((event) => event.recordId === key.recordId);

      if (remaining.length === 0) {
        keysToRemove.push(key);
        continue;
      }

      const latest = remaining[remaining.length - 1]!;
      const state: DirtyRecordState = latest.type === "delete" ? "deleted" : "dirty";
      await this.config.localChangeStore.upsertDirtyRecord({
        collection: key.collection,
        recordId: key.recordId,
        state,
        updatedAt: Date.now(),
      });
    }

    if (keysToRemove.length > 0) {
      await this.config.localChangeStore.removeDirtyRecords(keysToRemove);
    }
  }

  protected async readCheckpointMap(): Promise<Partial<Record<CollectionNames<C>, TCheckpoint>>> {
    const checkpointMap: Partial<Record<CollectionNames<C>, TCheckpoint>> = {};
    for (const collection of this.config.collections) {
      const collectionName = collection.name as CollectionNames<C>;
      const checkpoint = await this.config.checkpointStorage.getCheckpoint(collectionName);
      if (checkpoint !== undefined) {
        checkpointMap[collectionName] = checkpoint;
      }
    }
    return checkpointMap;
  }

  protected async saveCheckpointMap(
    checkpointMap: Partial<Record<CollectionNames<C>, TCheckpoint>>,
  ): Promise<void> {
    for (const collection of this.config.collections) {
      const collectionName = collection.name as CollectionNames<C>;
      const checkpoint = checkpointMap[collectionName];
      if (checkpoint === undefined) continue;
      await this.config.checkpointStorage.saveCheckpoint(collectionName, checkpoint);
    }
  }

  private primaryFieldName(collectionName: keyof SyncHandlerDataMap<C>): string {
    const collectionConfig = this.collectionMap.get(collectionName as CollectionNames<C>);
    return String(collectionConfig?.primaryField ?? "id");
  }

  private async upsertRow<N extends CollectionNames<C>>(
    collectionName: N,
    collectionConfig: ConfigForName<C, N>,
    row: Record<string, unknown>,
    db: DBAdapterOperations<C>,
  ): Promise<void> {
    const primaryField = collectionConfig.primaryField;
    const id = row[String(primaryField)];
    if (id !== undefined) {
      if (db.getOptional) {
        const existing = await db.getOptional(collectionName, id as never);
        if (existing !== undefined) {
          await db.update(collectionName, row as never);
          return;
        }
        await db.insert(collectionName, row as never);
        return;
      }
      const existing = await db.get(collectionName, id as never);
      if (existing !== undefined) {
        await db.update(collectionName, row as never);
        return;
      }
    }
    await db.insert(collectionName, row as never);
  }
}

/**
 * Coerce a stringified record id back to number when it looks numeric.
 * Primary keys are stored as strings in IndexedDB for indexing.
 */
function coerceRecordId(recordId: string): string | number {
  if (recordId !== "" && !Number.isNaN(Number(recordId)) && String(Number(recordId)) === recordId) {
    return Number(recordId);
  }
  return recordId;
}

function waitOrAbort(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
