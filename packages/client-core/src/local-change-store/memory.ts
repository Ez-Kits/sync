import type { DirtyRecord, ILocalChangeStore, StoredChangeBusEvent } from "./types";

function dirtyKey(collection: string, recordId: string): string {
  return `${collection}\0${recordId}`;
}

export function createMemoryLocalChangeStore(): ILocalChangeStore {
  const events = new Map<string, StoredChangeBusEvent>();
  const dirtyRecords = new Map<string, DirtyRecord>();

  return {
    async appendEvents(newEvents) {
      for (const event of newEvents) {
        events.set(event.id, event);
      }
    },

    async getPendingEvents(collection) {
      const all = Array.from(events.values());
      const filtered = collection ? all.filter((event) => event.collection === collection) : all;
      return filtered.sort((a, b) => a.createdAt - b.createdAt);
    },

    async deleteEvents(ids) {
      for (const id of ids) {
        events.delete(id);
      }
    },

    async upsertDirtyRecord(record) {
      dirtyRecords.set(dirtyKey(record.collection, record.recordId), record);
    },

    async removeDirtyRecords(keys) {
      for (const key of keys) {
        dirtyRecords.delete(dirtyKey(key.collection, key.recordId));
      }
    },

    async getDirtyRecords(collection) {
      const all = Array.from(dirtyRecords.values());
      return collection ? all.filter((record) => record.collection === collection) : all;
    },
  };
}
