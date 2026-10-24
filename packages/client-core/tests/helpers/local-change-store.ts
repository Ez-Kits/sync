import type {
  DirtyRecord,
  ILocalChangeStore,
  StoredChangeBusEvent,
} from "../../src/local-change-store";

function dirtyKey(collection: string, recordId: string): string {
  return `${collection}\0${recordId}`;
}

export function createTestLocalChangeStore(): ILocalChangeStore {
  const events = new Map<string, StoredChangeBusEvent>();
  const dirtyRecords = new Map<string, DirtyRecord>();
  const leases = new Map<string, { owner: string; expiresAt: number; fencingToken: number }>();

  return {
    supportsCrossContextLeases: false,
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
    async acquireLease(key, owner, now, ttlMs) {
      const lease = leases.get(key);
      if (lease && lease.owner !== owner && lease.expiresAt > now) return undefined;
      const fencingToken =
        lease?.owner === owner && lease.expiresAt > now
          ? lease.fencingToken
          : (lease?.fencingToken ?? 0) + 1;
      leases.set(key, { owner, expiresAt: now + ttlMs, fencingToken });
      return fencingToken;
    },
    async releaseLease(key, owner, fencingToken) {
      const lease = leases.get(key);
      if (lease?.owner === owner && lease.fencingToken === fencingToken) {
        lease.expiresAt = 0;
      }
    },
  };
}
