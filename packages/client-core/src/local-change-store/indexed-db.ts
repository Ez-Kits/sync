import type { DirtyRecord, ILocalChangeStore, StoredChangeBusEvent } from "./types";

const DEFAULT_DB_NAME = "ez-sync-local-changes";
const DB_VERSION = 1;
const EVENTS_STORE = "change_events";
const DIRTY_STORE = "dirty_records";
const COLLECTION_INDEX = "by_collection";

export interface IndexedDBLocalChangeStoreConfig {
  dbName?: string;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(EVENTS_STORE)) {
        const eventsStore = db.createObjectStore(EVENTS_STORE, { keyPath: "id" });
        eventsStore.createIndex(COLLECTION_INDEX, "collection", { unique: false });
      }
      if (!db.objectStoreNames.contains(DIRTY_STORE)) {
        const dirtyStore = db.createObjectStore(DIRTY_STORE, {
          keyPath: ["collection", "recordId"],
        });
        dirtyStore.createIndex(COLLECTION_INDEX, "collection", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
  });
}

export function createIndexedDBLocalChangeStore(
  config: IndexedDBLocalChangeStoreConfig = {},
): ILocalChangeStore {
  const dbName = config.dbName ?? DEFAULT_DB_NAME;
  let dbPromise: Promise<IDBDatabase> | undefined;

  const getDb = () => {
    dbPromise ??= openDatabase(dbName);
    return dbPromise;
  };

  return {
    async appendEvents(events) {
      if (events.length === 0) return;
      const db = await getDb();
      const tx = db.transaction(EVENTS_STORE, "readwrite");
      const store = tx.objectStore(EVENTS_STORE);
      for (const event of events) {
        store.put(event);
      }
      await transactionDone(tx);
    },

    async getPendingEvents(collection) {
      const db = await getDb();
      const tx = db.transaction(EVENTS_STORE, "readonly");
      const store = tx.objectStore(EVENTS_STORE);
      const events = collection
        ? await requestToPromise(store.index(COLLECTION_INDEX).getAll(IDBKeyRange.only(collection)))
        : await requestToPromise(store.getAll());
      await transactionDone(tx);
      return (events as StoredChangeBusEvent[]).sort((a, b) => a.createdAt - b.createdAt);
    },

    async deleteEvents(ids) {
      if (ids.length === 0) return;
      const db = await getDb();
      const tx = db.transaction(EVENTS_STORE, "readwrite");
      const store = tx.objectStore(EVENTS_STORE);
      for (const id of ids) {
        store.delete(id);
      }
      await transactionDone(tx);
    },

    async upsertDirtyRecord(record) {
      const db = await getDb();
      const tx = db.transaction(DIRTY_STORE, "readwrite");
      tx.objectStore(DIRTY_STORE).put(record);
      await transactionDone(tx);
    },

    async removeDirtyRecords(keys) {
      if (keys.length === 0) return;
      const db = await getDb();
      const tx = db.transaction(DIRTY_STORE, "readwrite");
      const store = tx.objectStore(DIRTY_STORE);
      for (const key of keys) {
        store.delete([key.collection, key.recordId]);
      }
      await transactionDone(tx);
    },

    async getDirtyRecords(collection) {
      const db = await getDb();
      const tx = db.transaction(DIRTY_STORE, "readonly");
      const store = tx.objectStore(DIRTY_STORE);
      const records = collection
        ? await requestToPromise(store.index(COLLECTION_INDEX).getAll(IDBKeyRange.only(collection)))
        : await requestToPromise(store.getAll());
      await transactionDone(tx);
      return records as DirtyRecord[];
    },
  };
}

export function isIndexedDBAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}
