/**
 * The messages the client adapter and the Durable Object exchange over one WebSocket per device:
 * pushes, pulls, previews, counts and token refreshes. While the socket isn't open and
 * authenticated, pushes go over HTTP instead, as a bare `PushRequest` answered by a `PushReply`.
 */

/** WebSocket subprotocol. The first token rides next to it: `new WebSocket(url, [SUBPROTOCOL, token])`. */
export const SUBPROTOCOL = "ezsync";

/** Close code when the token expired and no `auth` message refreshed it. Temporary: reconnect. */
export const CLOSE_UNAUTHENTICATED = 4001;

/** Close code when the scope was deleted. Permanent. */
export const CLOSE_SCOPE_DELETED = 4410;

/** Keep-alive: the client sends `PING` while the socket is open; the server answers `PONG` without waking. */
export const PING = "ping";
export const PONG = "pong";

/** A row as stored in the app's table, without `rev`, which travels next to it. */
export type Row = Record<string, unknown>;

/** Per collection, the last `seq` the device applied; `null` before the first pull. */
export type Checkpoints = Record<string, number | null>;

/**
 * A record's id, as `recordIdOf` from `@ez-kits/sync-client-core` builds it: the key as a string,
 * or for a composite key, the JSON array of its values in `primaryField` order (`["a",1]`).
 */
export type RecordId = string;

// --- Push ---

export interface PushEvent {
  /** Names the event in the reply and in logs; duplicates are found by `clientId` and `rev`. */
  eventId: string;
  collection: string;
  type: "create" | "update" | "delete";
  id: RecordId;
  /** The whole row for a create, the changed fields for an update. Absent on a delete. */
  data?: Row;
  /** The record's new revision: the stored `rev` + 1. */
  rev: number;
  deletedAt?: number;
}

/** A push. All events apply in one transaction, or none do. `requestId` matches a socket reply. */
export interface PushRequest {
  requestId: string;
  /**
   * The device's id (core's `PushOptions.clientId`). An event for a record this device wrote
   * last, with a `rev` at or below the stored one, is a resend and is answered as applied.
   * Without it, every event goes through the rev check.
   */
  clientId?: string;
  events: PushEvent[];
}

export type RejectionCode =
  | "invalid-argument"
  | "unknown-collection"
  | "unknown-column"
  | "scope-deleted"
  | "permission-denied"
  | "too-large";

/** The server's state of a record whose pushed `rev` didn't follow the stored one. */
export interface ConflictRecord {
  collection: string;
  id: RecordId;
  rev: number;
  /** The current row; absent when `deleted`. */
  data?: Row;
  deleted: boolean;
}

export type PushReply =
  | { ok: true; applied: { eventId: string; rev: number }[] }
  | { ok: false; reason: "conflict"; records: ConflictRecord[] }
  /** `index` is the refused event's position in `events`. Permanent: the device parks it. */
  | { ok: false; reason: "rejected"; index: number; code: RejectionCode }
  /** The token expired. Temporary: retry with a fresh token. */
  | { ok: false; reason: "unauthenticated" };

// --- WebSocket ---

/** A pulled change. `data` is the full row; absent when `deleted`. */
export interface Change {
  collection: string;
  id: RecordId;
  seq: number;
  rev: number;
  deleted: boolean;
  data?: Row;
}

/** How a preview picks its rows for one collection; `null` means newest first by `seq`. */
export interface PreviewSort {
  column: string;
  direction: "asc" | "desc";
}

export type ClientMessage =
  /**
   * Asks for the next page after `checkpoints`. With `count`, the server first sends one `count`
   * per collection.
   */
  | { type: "pull"; checkpoints: Checkpoints; limit?: number; count?: boolean }
  /** Asks for up to `limit` rows of each listed collection, with no checkpoint. */
  | { type: "preview"; collections: Record<string, PreviewSort | null>; limit: number }
  /** Refreshes the token on the open socket. */
  | { type: "auth"; token: string }
  /** A push over the open, authenticated socket; answered by `push-result`. */
  | ({ type: "push" } & PushRequest);

export type ServerMessage =
  /**
   * A page, or once caught up, the changes of a later commit. `checkpoints` holds the new
   * position of each collection in `changes`. `hasMore` asks the client to pull again.
   */
  | { type: "changes"; changes: Change[]; checkpoints: Record<string, number>; hasMore: boolean }
  /** Sent after the last page; the socket is live from here on. */
  | { type: "caught-up" }
  /** A commit too large for one message: pull from the checkpoints. */
  | { type: "poke" }
  /** The number of changes after the checkpoint, before the first page. */
  | { type: "count"; collection: string; total: number }
  /** The reply to a socket `push`. */
  | { type: "push-result"; requestId: string; reply: PushReply }
  /** The reply to a `preview`. */
  | { type: "preview"; changes: Change[] }
  /** The token expired: send `auth`, or the socket closes with `CLOSE_UNAUTHENTICATED`. */
  | { type: "unauthenticated" }
  /** Reserved for tombstone compaction: the checkpoints are too old to pull from. */
  | { type: "reset-required" };
