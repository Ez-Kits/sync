import {
  primaryFields,
  primaryKeyOf,
  recordIdOf,
  type ChangeBusEvent,
  type CollectionConfig,
} from "@ez-kits/sync-client-core";
import { getColumns, type Table } from "drizzle-orm";
import type { ConflictRecord, PushEvent, RecordId, Row } from "../protocol.ts";

export type AnyCollection = CollectionConfig<any, any, any, any, any, any, any>;
export type AnyEvent = ChangeBusEvent<any>;

/** A core outbox event as the server takes it: the record's id next to the row. */
export function toPushEvent(config: AnyCollection, event: AnyEvent): PushEvent {
  const base = {
    eventId: event.eventId as string,
    collection: String(event.collection),
    type: event.type,
    rev: event.rev as number,
  };
  if (event.type === "delete") {
    return { ...base, id: recordIdOf(config, event.id), deletedAt: event.deletedAt };
  }
  return { ...base, id: recordIdOf(config, primaryKeyOf(config, event.data)), data: event.data };
}

/**
 * Turns the server's records of one collection into core events. A Drizzle collection keeps
 * only its table's columns, so a server a schema ahead doesn't write columns the device lacks.
 */
export function createRecordReader(config: AnyCollection) {
  const table = (config.adapterConfig as { table?: Table }).table;
  const columns = table && new Set(Object.keys(getColumns(table)));
  const pick = (data: Row) =>
    columns ? Object.fromEntries(Object.entries(data).filter(([key]) => columns.has(key))) : data;
  // `recordIdOf` stringifies a single-field key: a Drizzle number column turns it back.
  const numericKey =
    !Array.isArray(config.primaryField) &&
    table !== undefined &&
    getColumns(table)[String(config.primaryField)]!.dataType.startsWith("number");
  const keyOf = (id: RecordId): unknown => {
    if (!Array.isArray(config.primaryField)) return numericKey ? Number(id) : id;
    const values = JSON.parse(id) as unknown[];
    return Object.fromEntries(primaryFields(config).map((field, index) => [field, values[index]]));
  };
  /** A pulled change or conflict record: a live row is a full upsert, a deleted one a delete. */
  return (record: Omit<ConflictRecord, "collection">): AnyEvent =>
    record.deleted
      ? { type: "delete", collection: config.name, id: keyOf(record.id), rev: record.rev }
      : { type: "update", collection: config.name, data: pick(record.data!), rev: record.rev };
}

export interface PushLimits {
  /** Events per request. */
  events: number;
  /** Bytes per request, below the platform's WebSocket message size. */
  bytes: number;
}

/** Room for the request around its events (`{"type":"push","requestId":…,"events":[]}`). */
const ENVELOPE_BYTES = 128;

/**
 * Splits events into requests within `limits`, as `[start, end)` ranges. An event that doesn't
 * fit a request on its own gets a range of its own marked `tooLarge`.
 */
export function chunkEvents(events: PushEvent[], limits: PushLimits) {
  const chunks: { start: number; end: number; tooLarge: boolean }[] = [];
  let start = 0;
  let bytes = ENVELOPE_BYTES;
  const flush = (end: number, tooLarge = false) => {
    if (end > start) chunks.push({ start, end, tooLarge });
    start = end;
    bytes = ENVELOPE_BYTES;
  };
  events.forEach((event, index) => {
    // +1 for the comma between events.
    const size = utf8Length(JSON.stringify(event)) + 1;
    if (ENVELOPE_BYTES + size > limits.bytes) {
      flush(index);
      flush(index + 1, true);
      return;
    }
    if (index - start >= limits.events || bytes + size > limits.bytes) flush(index);
    bytes += size;
  });
  flush(events.length);
  return chunks;
}

/** UTF-8 length of a string; the package compiles without DOM types, so no `TextEncoder`. */
function utf8Length(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    // A surrogate pair is one 4-byte character. JSON escapes lone surrogates.
    else if (code >= 0xd800 && code < 0xdc00) {
      length += 4;
      index += 1;
    } else length += 3;
  }
  return length;
}
