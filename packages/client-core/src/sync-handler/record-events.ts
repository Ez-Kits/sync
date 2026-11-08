import type { RecordKey, StoredChangeBusEvent } from "../local-change-store";

/** A record's identity as one string, for maps and sets. */
export function recordKeyString({ collection, recordId }: RecordKey): string {
  return `${collection}\0${recordId}`;
}

/** The push event of a pending outbox event. */
export function toPushEvent(stored: StoredChangeBusEvent) {
  if (stored.type === "delete") {
    return {
      type: "delete",
      collection: stored.collection,
      id: storedDeleteId(stored),
      deletedAt: stored.createdAt,
      eventId: stored.id,
    };
  }
  return {
    type: stored.type,
    collection: stored.collection,
    data: stored.data,
    eventId: stored.id,
  };
}

/** The id a stored delete was written with; older outboxes only kept it as a string. */
function storedDeleteId(stored: StoredChangeBusEvent): unknown {
  const { data } = stored;
  if (typeof data === "object" && data !== null && "id" in data) return data.id;
  return coerceRecordId(stored.recordId);
}

/**
 * Coerce a stringified record id back to number when it looks numeric.
 * Primary keys are stored as strings in IndexedDB for indexing.
 */
export function coerceRecordId(recordId: string): string | number {
  if (recordId !== "" && !Number.isNaN(Number(recordId)) && String(Number(recordId)) === recordId) {
    return Number(recordId);
  }
  return recordId;
}
