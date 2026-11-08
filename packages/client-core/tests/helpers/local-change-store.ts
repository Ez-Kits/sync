import { vi } from "vite-plus/test";
import type {
  ILocalChangeStore,
  LocalChangeScope,
  SkippedRemoteEvent,
  StoredChangeBusEvent,
} from "../../src/local-change-store";

function recordKey(collection: string, recordId: string): string {
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
  const appliedEventIds = new Set<string>();
  const checkpoints = new Map<string, string>();
  const skippedRemoteEvents = new Map<string, SkippedRemoteEvent>();
  const revisions = new Map<string, number>();

  return {
    initialize: vi.fn(async () => {}),
    async appendEvents(newEvents) {
      for (const event of newEvents) {
        events.set(event.id, event);
        appliedEventIds.add(event.id);
      }
    },
    async hasAppliedEvent(eventId) {
      return appliedEventIds.has(eventId);
    },
    async getPendingEvents(scope) {
      return Array.from(events.values()).filter((event) => inScope(event, scope));
    },
    async getPendingEventKeys() {
      return Array.from(events.values(), ({ id, collection }) => ({ id, collection }));
    },
    async deleteEvents(ids) {
      for (const id of ids) {
        events.delete(id);
      }
    },
    async getCheckpoint(collection) {
      return checkpoints.get(collection);
    },
    async saveCheckpoint(collection, value) {
      if (value === undefined) checkpoints.delete(collection);
      else checkpoints.set(collection, value);
    },
    async getSkippedRemoteEvents(scope) {
      return Array.from(skippedRemoteEvents.values()).filter((entry) => inScope(entry, scope));
    },
    async upsertSkippedRemoteEvent(entry) {
      // Stored as JSON, like the database stores do.
      skippedRemoteEvents.set(
        recordKey(entry.collection, entry.recordId),
        JSON.parse(JSON.stringify(entry)) as SkippedRemoteEvent,
      );
    },
    async removeSkippedRemoteEvents(keys) {
      for (const key of keys) {
        skippedRemoteEvents.delete(recordKey(key.collection, key.recordId));
      }
    },
    async getRevision(key) {
      return revisions.get(recordKey(key.collection, key.recordId));
    },
    async upsertRevision({ collection, recordId, rev }) {
      revisions.set(recordKey(collection, recordId), rev);
    },
    async removeRevisions(collection) {
      const pending = new Set(
        Array.from(events.values(), (event) => recordKey(event.collection, event.recordId)),
      );
      for (const key of revisions.keys()) {
        if (key.startsWith(recordKey(collection, "")) && !pending.has(key)) revisions.delete(key);
      }
    },
  };
}
