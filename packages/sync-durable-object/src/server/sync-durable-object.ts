import { DurableObject } from "cloudflare:workers";
import {
  and,
  asc,
  desc,
  eq,
  getColumns,
  sql,
  type AnyRelations,
  type EmptyRelations,
} from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  CLOSE_SCOPE_DELETED,
  CLOSE_UNAUTHENTICATED,
  SUBPROTOCOL,
  PING,
  PONG,
  type Change,
  type ClientMessage,
  type ConflictRecord,
  type PreviewSort,
  type PushEvent,
  type PushReply,
  type RecordId,
  type RejectionCode,
  type Row,
  type ServerMessage,
} from "../protocol.ts";
import { EXPIRES_AT_HEADER, PRINCIPAL_HEADER } from "./route.ts";

const PAGE_LIMIT = 500;
const EVENT_TYPES = new Set(["create", "update", "delete"]);
const LIBRARY_TABLES = [
  `CREATE TABLE IF NOT EXISTS ez_sync_records (collection TEXT NOT NULL, id TEXT NOT NULL,
    rev INTEGER NOT NULL, seq INTEGER NOT NULL, deleted INTEGER NOT NULL, deleted_at INTEGER,
    client_id TEXT, PRIMARY KEY (collection, id)) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS ez_sync_records_seq ON ez_sync_records (collection, seq)",
  "CREATE TABLE IF NOT EXISTS ez_sync_meta (key TEXT PRIMARY KEY, value) WITHOUT ROWID",
];

/** A synced collection: the app's Drizzle table, named like the client's collection. */
export interface SyncCollection {
  table: SQLiteTable;
}

/** What `authenticate()` returns for a valid token. */
export interface SyncAuthentication {
  principal: unknown;
  /** In ms since the epoch. */
  expiresAt: number;
}

/** A write from the app's own code. The library takes the stored `rev` + 1 itself. */
export interface SyncWriteEvent {
  collection: string;
  type: "create" | "update" | "delete";
  id: RecordId;
  data?: Row;
  deletedAt?: number;
}

/** A row loaded by `importRows()`, keeping the `rev` it had in the old backend. */
export interface SyncImportRow {
  collection: string;
  id: RecordId;
  data: Row;
  rev: number;
}

/** A write refused by a rejection; `index` is its position in the events or rows given. */
export class SyncRejectedError extends Error {
  override readonly name = "SyncRejectedError";
  constructor(
    readonly index: number,
    readonly code: RejectionCode,
  ) {
    super(`The write at index ${index} was rejected: ${code}.`);
  }
}

interface Attachment {
  principal: unknown;
  expiresAt: number;
  /** Caught up: receives every later commit. */
  live: boolean;
  /** `unauthenticated` was sent; the next expired message closes the socket. */
  warned: boolean;
  /** An `auth` brought another principal: pushes are refused and nothing is sent. */
  denied: boolean;
}

interface TableInfo {
  table: SQLiteTable;
  /** By JS property name, as rows travel. */
  columns: Record<string, SQLiteColumn>;
  /** The primary-key properties, in the order a composite `RecordId` lists them. */
  keys: string[];
  /** SQL that is true when the record `r` has no row left in the table. */
  missing: string;
  /** Has an `ON DELETE CASCADE` foreign key: deleting a parent can remove its rows. */
  cascades: boolean;
}

interface StoredRecord {
  [column: string]: SqlStorageValue;
  id: string;
  rev: number;
  seq: number;
  deleted: number;
  /** The device that wrote the current revision; null for server writes, imports and cascades. */
  client_id: string | null;
}

interface Target {
  collection: string;
  id: RecordId;
  info: TableInfo;
}

type Source = "device" | "server";
type RejectedReply = Extract<PushReply, { reason: "rejected" }>;
type Applied = { eventId: string; rev: number; seq: number };

/** Thrown inside the push transaction to roll it back. */
class Rollback {
  constructor(readonly outcome: RejectedReply | Target[]) {}
}

/**
 * A Durable Object holding one scope's synced rows. Subclass it and set `migrations` and
 * `collections`; add `relations` for `db.query` and the optional hooks. The library reserves the `/sync` paths and the
 * members starting with `sync`.
 */
export abstract class SyncDurableObject<
  Env = unknown,
  Relations extends AnyRelations = EmptyRelations,
> extends DurableObject<Env> {
  /** The drizzle-kit output for `durable-sqlite` (`import migrations from "./drizzle/migrations"`). */
  abstract migrations: { migrations: Record<string, string> };
  abstract collections: Record<string, SyncCollection>;
  /** `defineRelations(schema, …)`, giving `db.query.<table>.findMany({ with })`. */
  relations?: Relations;

  /** Rows per transaction in `importRows()`. */
  importBatchSize = 500;
  /** Larger pushes are rejected with `too-large`; larger commits reach live sockets as `poke`. */
  maxMessageBytes = 1_000_000;

  /** Drizzle over the scope's SQLite. Read freely; write through `write()` so devices see it. */
  get db(): DrizzleSqliteDODatabase<Relations> {
    // Built on first use: the subclass sets `relations` after this class's constructor runs.
    return (this.syncDb ??= drizzle(this.ctx.storage, { relations: this.relations }));
  }
  private syncDb?: DrizzleSqliteDODatabase<Relations>;

  private syncDeleted = false;
  private readonly syncTables = new Map<string, TableInfo>();

  /** Checks a refreshed token from an `auth` socket message; null when it isn't valid. */
  authenticate?(token: string): Promise<SyncAuthentication | null> | SyncAuthentication | null;
  /** Refuses a write for good. Runs inside the write transaction, so it must not await. */
  validate?(input: {
    event: PushEvent;
    current: Row | null;
    principal: unknown;
  }): { reject: RejectionCode } | undefined;
  /** Runs after a commit, outside the transaction. A throw is logged. */
  onCommitted?(input: { changes: Change[]; source: Source }): Promise<void> | void;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    void ctx.blockConcurrencyWhile(async () => {
      // The subclass sets `migrations` once this constructor returns.
      await Promise.resolve();
      migrate(this.db, this.migrations);
      for (const statement of LIBRARY_TABLES) ctx.storage.sql.exec(statement);
      this.syncDeleted = this.syncMeta("scope_deleted") !== null;
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const principalHeader = request.headers.get(PRINCIPAL_HEADER);
    if (principalHeader === null) return new Response(null, { status: 404 });
    const principal: unknown = JSON.parse(principalHeader);
    if (request.headers.get("Upgrade") === "websocket") {
      return this.syncAccept(principal, Number(request.headers.get(EXPIRES_AT_HEADER)));
    }
    if (url.pathname !== "/sync/push" && url.pathname !== "/sync/pull") {
      return new Response(null, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (body === null) return new Response(null, { status: 400 });
    if (url.pathname === "/sync/push") {
      const { reply } = await this.syncPush(body.events, "device", principal, body.clientId);
      return Response.json(reply);
    }
    if (this.syncDeleted) return new Response(null, { status: 410 });
    return Response.json(this.syncPage(body.checkpoints, body.limit));
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const message = JSON.parse(raw as string) as ClientMessage;
    if (message.type === "auth") return this.syncAuth(ws, message.token);
    const attachment = ws.deserializeAttachment() as Attachment;
    if (Date.now() >= attachment.expiresAt) {
      if (attachment.warned) return ws.close(CLOSE_UNAUTHENTICATED, "unauthenticated");
      ws.serializeAttachment({ ...attachment, warned: true } satisfies Attachment);
      send(ws, { type: "unauthenticated" });
      if (message.type === "push") {
        const reply: PushReply = { ok: false, reason: "unauthenticated" };
        send(ws, { type: "push-result", requestId: message.requestId, reply });
      }
      return;
    }
    if (attachment.denied) {
      if (message.type === "push") {
        send(ws, {
          type: "push-result",
          requestId: message.requestId,
          reply: rejected(0, "permission-denied"),
        });
      }
      return;
    }
    if (message.type === "push") {
      const { reply } = await this.syncPush(
        message.events,
        "device",
        attachment.principal,
        message.clientId,
      );
      send(ws, { type: "push-result", requestId: message.requestId, reply });
    } else if (message.type === "pull") {
      if (message.count) {
        for (const [collection, checkpoint] of this.syncKnown(message.checkpoints)) {
          const [{ total }] = this.ctx.storage.sql
            .exec<{ total: number }>(
              "SELECT count(*) AS total FROM ez_sync_records WHERE collection = ? AND seq > ?",
              collection,
              checkpoint,
            )
            .toArray() as [{ total: number }];
          send(ws, { type: "count", collection, total });
        }
      }
      const page = this.syncPage(message.checkpoints, message.limit);
      // Same turn as the last page: no commit can fall between it and going live.
      ws.serializeAttachment({ ...attachment, live: !page.hasMore } satisfies Attachment);
      send(ws, page);
      if (!page.hasMore) send(ws, { type: "caught-up" });
    } else {
      send(ws, { type: "preview", changes: this.syncPreview(message.collections, message.limit) });
    }
  }

  /** Writes from the app's own code, through the device path: devices receive them. */
  async write(events: SyncWriteEvent[]): Promise<{ rev: number; seq: number }[]> {
    const withIds = events.map((event) => ({ ...event, eventId: crypto.randomUUID() }));
    const { reply, applied } = await this.syncPush(withIds, "server", null, undefined);
    if (!reply.ok) {
      // A server write takes the stored rev + 1, so it never conflicts.
      const { index, code } = reply as RejectedReply;
      throw new SyncRejectedError(index, code);
    }
    return applied.map(({ rev, seq }) => ({ rev, seq }));
  }

  /**
   * Bulk-loads rows from another backend, keeping their `rev`, in transactions of
   * `importBatchSize` rows. A refused row throws and rolls back its batch only.
   */
  importRows(rows: SyncImportRow[]): void {
    if (this.syncDeleted) throw new SyncRejectedError(0, "scope-deleted");
    for (let start = 0; start < rows.length; start += this.importBatchSize) {
      this.ctx.storage.transactionSync(() => {
        let seq = this.syncSeq();
        for (const [offset, row] of rows.slice(start, start + this.importBatchSize).entries()) {
          const checked = this.syncCheck(row.collection, row.id, row.data);
          if (typeof checked === "string") throw new SyncRejectedError(start + offset, checked);
          this.syncUpsert(checked.info, checked.keyValues, checked.row, "create");
          seq += 1;
          this.syncStoreRecord(row.collection, row.id, row.rev, seq, null, null);
        }
        this.syncSetMeta("seq", seq);
      });
    }
    // Live sockets pull the imported rows from their checkpoints.
    this.syncSendLive(JSON.stringify({ type: "poke" } satisfies ServerMessage));
  }

  /** Wipes the scope, closes its sockets and refuses every later request with `scope-deleted`. */
  async deleteScope(): Promise<void> {
    this.syncDeleted = true;
    for (const ws of this.ctx.getWebSockets()) ws.close(CLOSE_SCOPE_DELETED, "scope deleted");
    await this.ctx.storage.deleteAll();
    this.ctx.storage.sql.exec(LIBRARY_TABLES[2]!);
    this.syncSetMeta("scope_deleted", Date.now());
  }

  private syncAccept(principal: unknown, expiresAt: number): Response {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const attachment: Attachment = {
      principal,
      expiresAt,
      live: false,
      warned: false,
      denied: false,
    };
    pair[1].serializeAttachment(attachment);
    if (this.syncDeleted) pair[1].close(CLOSE_SCOPE_DELETED, "scope deleted");
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "Sec-WebSocket-Protocol": SUBPROTOCOL },
    });
  }

  private async syncAuth(ws: WebSocket, token: string): Promise<void> {
    const result = await this.authenticate?.(token);
    if (!result) return;
    const attachment = ws.deserializeAttachment() as Attachment;
    const next =
      JSON.stringify(result.principal) === JSON.stringify(attachment.principal)
        ? { ...attachment, expiresAt: result.expiresAt, warned: false }
        : { ...attachment, denied: true, live: false };
    ws.serializeAttachment(next satisfies Attachment);
  }

  /** The one push path for HTTP, the socket and `write()`: one transaction, all or nothing. */
  private async syncPush(
    events: unknown,
    source: Source,
    principal: unknown,
    clientId: unknown,
  ): Promise<{ reply: PushReply; applied: Applied[] }> {
    if (this.syncDeleted) return { reply: rejected(0, "scope-deleted"), applied: [] };
    if (!Array.isArray(events) || (clientId != null && typeof clientId !== "string")) {
      return { reply: rejected(0, "invalid-argument"), applied: [] };
    }
    if (byteLength(JSON.stringify(events)) > this.maxMessageBytes) {
      return { reply: rejected(0, "too-large"), applied: [] };
    }
    let result: { applied: Applied[]; changes: Change[] };
    try {
      result = this.ctx.storage.transactionSync(() =>
        this.syncApply(events, source, principal, clientId ?? null),
      );
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
      if (!Array.isArray(error.outcome)) return { reply: error.outcome, applied: [] };
      // Read after the rollback: the state before this request.
      const records = error.outcome.map((target) => this.syncConflictRecord(target));
      return { reply: { ok: false, reason: "conflict", records }, applied: [] };
    }
    if (result.changes.length > 0) {
      this.syncBroadcast(result.changes);
      try {
        await this.onCommitted?.({ changes: result.changes, source });
      } catch (error) {
        console.error("ez-sync: onCommitted threw", error);
      }
    }
    const applied = result.applied.map(({ eventId, rev }) => ({ eventId, rev }));
    return { reply: { ok: true, applied }, applied: result.applied };
  }

  private syncApply(
    events: unknown[],
    source: Source,
    principal: unknown,
    clientId: string | null,
  ): { applied: Applied[]; changes: Change[] } {
    const now = Date.now();
    let seq = this.syncSeq();
    const applied: Applied[] = [];
    const touched = new Map<string, Target>();
    const conflicts = new Map<string, Target>();
    let deleted = false;
    for (const [index, value] of events.entries()) {
      const event = value as PushEvent | null;
      if (
        typeof event?.eventId !== "string" ||
        !EVENT_TYPES.has(event.type) ||
        (source === "device" && !Number.isInteger(event.rev))
      ) {
        throw new Rollback(rejected(index, "invalid-argument"));
      }
      const checked = this.syncCheck(event.collection, event.id, event.data);
      if (typeof checked === "string") throw new Rollback(rejected(index, checked));
      const { info, keyValues, row } = checked;
      const target = { collection: event.collection, id: event.id, info };
      const key = JSON.stringify([event.collection, event.id]);
      const stored = this.syncRecord(event.collection, event.id);
      // A resend of this device's own write (its reply was lost): already applied.
      if (clientId !== null && stored?.client_id === clientId && event.rev <= stored.rev) {
        applied.push({ eventId: event.eventId, rev: stored.rev, seq: stored.seq });
        continue;
      }
      const storedRev = stored?.rev ?? 0;
      // Server writes carry no rev: they take the next one.
      const rev = event.rev ?? storedRev + 1;
      if (rev !== storedRev + 1) {
        conflicts.set(key, target);
        continue;
      }
      if (this.validate) {
        const current = this.syncReadRow(info, keyValues) ?? null;
        const verdict = this.validate({ event: { ...event, rev }, current, principal });
        if (verdict) throw new Rollback(rejected(index, verdict.reject));
      }
      try {
        if (event.type === "delete") {
          this.db.delete(info.table).where(this.syncWhere(info, keyValues)).run();
          deleted = true;
        } else {
          this.syncUpsert(info, keyValues, row, event.type);
        }
      } catch {
        // A constraint failed, e.g. a NOT NULL column left out. The error may quote row data.
        throw new Rollback(rejected(index, "invalid-argument"));
      }
      seq += 1;
      const deletedAt = typeof event.deletedAt === "number" ? event.deletedAt : now;
      this.syncStoreRecord(
        event.collection,
        event.id,
        rev,
        seq,
        event.type === "delete" ? deletedAt : null,
        clientId,
      );
      applied.push({ eventId: event.eventId, rev, seq });
      touched.set(key, target);
    }
    if (conflicts.size > 0) throw new Rollback([...conflicts.values()]);
    if (deleted) seq = this.syncTombstoneCascaded(seq, now, touched);
    this.syncSetMeta("seq", seq);
    const changes = [...touched.values()].map(({ collection, id, info }) =>
      this.syncChange(collection, info, this.syncRecord(collection, id)!),
    );
    return { applied, changes: changes.sort((a, b) => a.seq - b.seq) };
  }

  /**
   * Tombstones the records whose rows a cascade removed, at every level: SQLite already ran the
   * whole cascade, so one pass over the cascading collections finds them all.
   */
  // shortcut: scans the live records of every cascading collection on each push, narrow it to the deleted parents' keys if that gets slow.
  private syncTombstoneCascaded(seq: number, now: number, touched: Map<string, Target>): number {
    for (const collection of Object.keys(this.collections)) {
      const info = this.syncTable(collection)!;
      if (!info.cascades) continue;
      const gone = this.ctx.storage.sql
        .exec<{ id: string; rev: number }>(
          `SELECT id, rev FROM ez_sync_records r WHERE collection = ? AND deleted = 0 AND ${info.missing}`,
          collection,
        )
        .toArray();
      for (const { id, rev } of gone) {
        seq += 1;
        this.syncStoreRecord(collection, id, rev + 1, seq, now, null);
        touched.set(JSON.stringify([collection, id]), { collection, id, info });
      }
    }
    return seq;
  }

  /** Validates a write's collection, id and columns; a rejection code when it can't apply. */
  private syncCheck(
    collection: unknown,
    id: unknown,
    data: unknown,
  ): { info: TableInfo; keyValues: Row; row: Row } | RejectionCode {
    const info = typeof collection === "string" ? this.syncTable(collection) : undefined;
    if (!info) return "unknown-collection";
    const isRow = typeof data === "object" && data !== null && !Array.isArray(data);
    if (typeof id !== "string" || (data !== undefined && !isRow)) return "invalid-argument";
    const row = (data ?? {}) as Row;
    if (Object.keys(row).some((key) => !Object.hasOwn(info.columns, key))) return "unknown-column";
    const values = keyValuesOf(info, id);
    if (!values) return "invalid-argument";
    return { info, row, keyValues: keyRow(info, values) };
  }

  private syncTable(collection: string): TableInfo | undefined {
    if (!Object.hasOwn(this.collections, collection)) return undefined;
    let info = this.syncTables.get(collection);
    if (!info) {
      const { table } = this.collections[collection]!;
      const columns = getColumns(table) as Record<string, SQLiteColumn>;
      const config = getTableConfig(table);
      const keyColumns =
        config.primaryKeys[0]?.columns ?? config.columns.filter((column) => column.primary);
      const keys = keyColumns.map((column) =>
        Object.keys(columns).find((key) => columns[key] === column)!,
      );
      // As `recordIdOf` builds ids: the value itself, or a JSON array for a composite key.
      const match = keys.map((key, i) => {
        const value = keys.length === 1 ? "r.id" : `json_extract(r.id, '$[${i}]')`;
        return `t.${quote(columns[key]!.name)} = ${value}`;
      });
      const missing = `NOT EXISTS (SELECT 1 FROM ${quote(config.name)} t WHERE ${match.join(" AND ")})`;
      const cascades = config.foreignKeys.some((key) => key.onDelete === "cascade");
      info = { table, columns, keys, missing, cascades };
      this.syncTables.set(collection, info);
    }
    return info;
  }

  /**
   * A create replaces the whole row, an update merges its fields into it; either brings back a
   * missing row. Replaces in place: delete-then-insert would cascade to child rows.
   */
  // shortcut: needs a non-key column and sets generated ones too, handle both once an app syncs such a table.
  private syncUpsert(info: TableInfo, keyValues: Row, row: Row, type: "create" | "update"): void {
    const fields = Object.keys(row).filter((key) => !info.keys.includes(key));
    // An insert would check NOT NULL columns the update leaves out before resolving the conflict.
    if (type === "update" && this.syncReadRow(info, keyValues)) {
      if (fields.length === 0) return;
      const set = Object.fromEntries(fields.map((key) => [key, row[key]]));
      this.db.update(info.table).set(set).where(this.syncWhere(info, keyValues)).run();
      return;
    }
    // A column the row leaves out takes the value the insert gave it: its default or null.
    const set = Object.fromEntries(
      Object.keys(info.columns)
        .filter((key) => !info.keys.includes(key))
        .map((key) => [key, sql`excluded.${sql.identifier(info.columns[key]!.name)}`]),
    );
    const target = info.keys.map((key) => info.columns[key]!);
    this.db
      .insert(info.table)
      .values({ ...row, ...keyValues })
      .onConflictDoUpdate({ target, set })
      .run();
  }

  private syncWhere(info: TableInfo, keyValues: Row) {
    return and(...info.keys.map((key) => eq(info.columns[key]!, keyValues[key])));
  }

  private syncReadRow(info: TableInfo, keyValues: Row): Row | undefined {
    return this.db.select().from(info.table).where(this.syncWhere(info, keyValues)).get() as
      | Row
      | undefined;
  }

  private syncRecord(collection: string, id: RecordId): StoredRecord | undefined {
    return this.ctx.storage.sql
      .exec<StoredRecord>(
        "SELECT id, rev, seq, deleted, client_id FROM ez_sync_records WHERE collection = ? AND id = ?",
        collection,
        id,
      )
      .toArray()[0];
  }

  private syncStoreRecord(
    collection: string,
    id: RecordId,
    rev: number,
    seq: number,
    deletedAt: number | null,
    clientId: string | null,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO ez_sync_records VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (collection, id) DO UPDATE
        SET rev = excluded.rev, seq = excluded.seq, deleted = excluded.deleted,
        deleted_at = excluded.deleted_at, client_id = excluded.client_id`,
      collection,
      id,
      rev,
      seq,
      deletedAt === null ? 0 : 1,
      deletedAt,
      clientId,
    );
  }

  private syncChange(collection: string, info: TableInfo, record: StoredRecord): Change {
    const { id, rev, seq } = record;
    const data = record.deleted
      ? undefined
      : this.syncReadRow(info, keyRow(info, keyValuesOf(info, id)!));
    // A row removed past `write()` reads as deleted, never as a row without data.
    if (!data) return { collection, id, seq, rev, deleted: true };
    return { collection, id, seq, rev, deleted: false, data };
  }

  private syncConflictRecord({ collection, id, info }: Target): ConflictRecord {
    const record = this.syncRecord(collection, id);
    // Never written: the server has no such record.
    if (!record) return { collection, id, rev: 0, deleted: true };
    const { seq: _seq, ...state } = this.syncChange(collection, info, record);
    return state;
  }

  private syncKnown(checkpoints: unknown): [string, number][] {
    return Object.entries((checkpoints ?? {}) as Record<string, number | null>)
      .filter(([collection]) => this.syncTable(collection))
      .map(([collection, checkpoint]) => [collection, checkpoint ?? 0]);
  }

  /** The oldest changes after the checkpoints, across their collections. */
  private syncPage(
    checkpoints: unknown,
    limit: unknown,
  ): Extract<ServerMessage, { type: "changes" }> {
    const size = Math.min(Number(limit) || PAGE_LIMIT, PAGE_LIMIT);
    const records: [string, StoredRecord][] = [];
    for (const [collection, checkpoint] of this.syncKnown(checkpoints)) {
      const rows = this.ctx.storage.sql
        .exec<StoredRecord>(
          `SELECT id, rev, seq, deleted FROM ez_sync_records WHERE collection = ? AND seq > ?
            ORDER BY seq LIMIT ?`,
          collection,
          checkpoint,
          size + 1,
        )
        .toArray();
      for (const row of rows) records.push([collection, row]);
    }
    records.sort((a, b) => a[1].seq - b[1].seq);
    const changes = records
      .slice(0, size)
      .map(([collection, record]) =>
        this.syncChange(collection, this.syncTable(collection)!, record),
      );
    return {
      type: "changes",
      changes,
      checkpoints: checkpointsOf(changes),
      hasMore: records.length > size,
    };
  }

  private syncPreview(collections: Record<string, PreviewSort | null>, limit: number): Change[] {
    const size = Math.min(limit, PAGE_LIMIT);
    const changes: Change[] = [];
    for (const [collection, sort] of Object.entries(collections)) {
      const info = this.syncTable(collection);
      if (!info) continue;
      if (sort === null) {
        const records = this.ctx.storage.sql
          .exec<StoredRecord>(
            `SELECT id, rev, seq, deleted FROM ez_sync_records WHERE collection = ? AND deleted = 0
              ORDER BY seq DESC LIMIT ?`,
            collection,
            size,
          )
          .toArray();
        changes.push(...records.map((record) => this.syncChange(collection, info, record)));
        continue;
      }
      const column = Object.hasOwn(info.columns, sort.column)
        ? info.columns[sort.column]
        : undefined;
      if (!column || (sort.direction !== "asc" && sort.direction !== "desc")) continue;
      const order = sort.direction === "asc" ? asc(column) : desc(column);
      const rows = this.db.select().from(info.table).orderBy(order).limit(size).all() as Row[];
      for (const data of rows) {
        const record = this.syncRecord(collection, recordIdOf(info, data));
        // A row written past `write()` has no revision to sync.
        if (record)
          changes.push({
            collection,
            id: record.id,
            seq: record.seq,
            rev: record.rev,
            deleted: false,
            data,
          });
      }
    }
    return changes;
  }

  private syncBroadcast(changes: Change[]): void {
    const message = JSON.stringify({
      type: "changes",
      changes,
      checkpoints: checkpointsOf(changes),
      hasMore: false,
    } satisfies ServerMessage);
    const tooLarge = byteLength(message) > this.maxMessageBytes;
    this.syncSendLive(
      tooLarge ? JSON.stringify({ type: "poke" } satisfies ServerMessage) : message,
    );
  }

  private syncSendLive(message: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() as Attachment).live) ws.send(message);
    }
  }

  private syncSeq(): number {
    return Number(this.syncMeta("seq") ?? 0);
  }

  private syncMeta(key: string): SqlStorageValue {
    const rows = this.ctx.storage.sql
      .exec<{ value: SqlStorageValue }>("SELECT value FROM ez_sync_meta WHERE key = ?", key)
      .toArray();
    return rows[0]?.value ?? null;
  }

  private syncSetMeta(key: string, value: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO ez_sync_meta VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }
}

function send(ws: WebSocket, message: ServerMessage): void {
  ws.send(JSON.stringify(message));
}

function rejected(index: number, code: RejectionCode): RejectedReply {
  return { ok: false, reason: "rejected", index, code };
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function checkpointsOf(changes: Change[]): Record<string, number> {
  return Object.fromEntries(changes.map((change) => [change.collection, change.seq]));
}

/** The key values a `RecordId` holds, or null when it doesn't fit the table's key. */
function keyValuesOf(info: TableInfo, id: string): unknown[] | null {
  if (info.keys.length === 1) return [id];
  let values: unknown;
  try {
    values = JSON.parse(id);
  } catch {
    return null;
  }
  const fits =
    Array.isArray(values) &&
    values.length === info.keys.length &&
    values.every((value) => typeof value === "string" || typeof value === "number");
  return fits ? (values as unknown[]) : null;
}

function keyRow(info: TableInfo, values: unknown[]): Row {
  return Object.fromEntries(info.keys.map((key, i) => [key, values[i]]));
}

/** As `recordIdOf` in client core builds it. */
function recordIdOf(info: TableInfo, row: Row): RecordId {
  const values = info.keys.map((key) => row[key]);
  return info.keys.length === 1 ? String(values[0]) : JSON.stringify(values);
}
