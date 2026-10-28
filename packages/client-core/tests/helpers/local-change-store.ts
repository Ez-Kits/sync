import { vi } from "vite-plus/test";
import type {
  DirtyRecord,
  ILocalChangeStore,
  LocalChangeScope,
  StoredChangeBusEvent,
} from "../../src/local-change-store";

function dirtyKey(collection: string, recordId: string): string {
  return `${collection}\0${recordId}`;
}

function inScope(item: { collection: string; recordId: string }, scope?: LocalChangeScope) {
  if (scope === undefined) return true;
  if (typeof scope === "string") return item.collection === scope;
  return item.collection === scope.collection && item.recordId === scope.recordId;
}

export function createTestLocalChangeStore(): ILocalChangeStore {
  // Like the database's `seq`: events are read back in append order.
  const events = new Map<string, StoredChangeBusEvent>();
  const dirtyRecords = new Map<string, DirtyRecord>();

  return {
    initialize: vi.fn(async () => {}),
    async appendEvents(newEvents) {
      for (const event of newEvents) {
        events.set(event.id, event);
      }
    },
    async getPendingEvents(scope) {
      return Array.from(events.values()).filter((event) => inScope(event, scope));
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
    async getDirtyRecords(scope) {
      return Array.from(dirtyRecords.values()).filter((record) => inScope(record, scope));
    },
  };
}
