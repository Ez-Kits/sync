import type {
  Change,
  Checkpoints,
  ClientMessage,
  PreviewSort,
  PushReply,
  PushRequest,
  RejectionCode,
  Row,
  ServerMessage,
} from "../../src/protocol.ts";
import { PING, PONG } from "../../src/protocol.ts";
import type { FetchLike, WebSocketConstructor, WebSocketLike } from "../../src/client.ts";

interface StoredRecord {
  rev: number;
  seq: number;
  deleted: boolean;
  data?: Row;
  clientId?: string;
}

/** Lets queued messages and promise chains run. */
export async function flush(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

type Listener = (event: any) => void;

/** The client's end of a socket to the fake server. */
export class FakeSocket implements WebSocketLike {
  readonly sent: ClientMessage[] = [];
  pings = 0;
  closed = false;
  closedWith: number | undefined;
  private listeners = new Map<string, Listener[]>();

  constructor(
    readonly server: FakeServer,
    readonly url: string,
    readonly protocols: string[],
  ) {}

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string) {
    if (this.closed) throw new Error("socket closed");
    // The Durable Object's auto-response answers without waking it.
    if (data === PING) {
      this.pings += 1;
      void Promise.resolve().then(() => this.deliver(PONG));
      return;
    }
    const message = JSON.parse(data) as ClientMessage;
    this.sent.push(message);
    void Promise.resolve().then(() => this.server.onMessage(this, message));
  }

  close(code?: number) {
    this.closed = true;
    this.closedWith = code;
    this.server.sockets.delete(this);
  }

  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** The server sends a message. */
  deliver(message: ServerMessage | string) {
    if (this.closed) return;
    this.emit("message", { data: typeof message === "string" ? message : JSON.stringify(message) });
  }

  /** The server or the network closes the socket. */
  serverClose(code: number) {
    this.close(code);
    this.emit("close", { code });
  }
}

/**
 * An in-memory Durable Object of one scope that speaks the protocol: rows with revisions, a
 * change log numbered by `seq`, live changes to caught-up sockets and HTTP.
 */
export class FakeServer {
  records = new Map<string, StoredRecord>();
  seq = 0;
  sockets = new Set<FakeSocket>();
  allSockets: FakeSocket[] = [];
  caughtUp = new Set<FakeSocket>();
  /** Accepted tokens. */
  tokens = new Set(["t1"]);
  pageSize = 500;
  /** A live commit of more changes than this is a `poke`. */
  pokeAbove = Infinity;
  /** `new WebSocket` throws, as when the platform has none. */
  noSockets = false;
  /** Sockets don't open by themselves; call `socket.emit("open")`. */
  manualOpen = false;
  /** Apply the next push but lose its reply. */
  loseNextReply = false;
  /** Answer HTTP with this status instead. */
  httpStatus: number | undefined;
  reject: ((event: PushRequest["events"][number]) => RejectionCode | undefined) | undefined;
  pushes: { via: "socket" | "http"; request: PushRequest }[] = [];
  httpRequests: { url: string; headers: Record<string, string>; body: unknown }[] = [];

  readonly WebSocket = ((server: FakeServer) =>
    class {
      constructor(url: string, protocols: string[]) {
        if (server.noSockets) throw new Error("no WebSocket");
        const socket = new FakeSocket(server, url, protocols);
        server.sockets.add(socket);
        server.allSockets.push(socket);
        if (!server.manualOpen) void Promise.resolve().then(() => socket.emit("open"));
        return socket;
      }
    })(this) as unknown as WebSocketConstructor;

  readonly fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as unknown;
    this.httpRequests.push({ url, headers: init.headers, body });
    if (this.httpStatus !== undefined) {
      return { ok: false, status: this.httpStatus, json: async () => ({}) };
    }
    const token = init.headers.authorization?.replace("Bearer ", "");
    let reply: unknown;
    if (url.endsWith("/push")) {
      const request = body as PushRequest;
      reply = this.tokens.has(token!)
        ? this.push(request, "http")
        : { ok: false, reason: "unauthenticated" };
      if (this.loseNextReply) {
        this.loseNextReply = false;
        throw new Error("network error");
      }
    } else {
      const { checkpoints } = body as { checkpoints: Checkpoints };
      reply = this.page(checkpoints);
    }
    return { ok: true, status: 200, json: async () => reply };
  };

  key(collection: string, id: string) {
    return JSON.stringify([collection, id]);
  }

  /** Applies a push in one all-or-nothing transaction. */
  push(request: PushRequest, via: "socket" | "http"): PushReply {
    this.pushes.push({ via, request });
    const staged = new Map<string, StoredRecord>();
    const current = (collection: string, id: string) =>
      staged.get(this.key(collection, id)) ?? this.records.get(this.key(collection, id));
    // As the Durable Object: a resend of this device's own write is already applied.
    const isResend = (event: { rev: number }, record: StoredRecord | undefined) =>
      request.clientId !== undefined &&
      record?.clientId === request.clientId &&
      event.rev <= record.rev;
    for (const [index, event] of request.events.entries()) {
      const stored = current(event.collection, event.id);
      if (isResend(event, stored)) continue;
      if (event.rev !== (stored?.rev ?? 0) + 1) {
        const records = request.events
          .filter((other) => {
            const record = this.records.get(this.key(other.collection, other.id));
            return !isResend(other, record) && other.rev !== (record?.rev ?? 0) + 1;
          })
          .map((other) => {
            const record = this.records.get(this.key(other.collection, other.id));
            return {
              collection: other.collection,
              id: other.id,
              rev: record?.rev ?? 0,
              deleted: record?.deleted ?? true,
              ...(record && !record.deleted && { data: record.data }),
            };
          });
        return { ok: false, reason: "conflict", records };
      }
      const code = this.reject?.(event);
      if (code) return { ok: false, reason: "rejected", index, code };
      const data =
        event.type === "delete"
          ? undefined
          : event.type === "create" || stored?.deleted
            ? event.data
            : { ...stored?.data, ...event.data };
      staged.set(this.key(event.collection, event.id), {
        rev: event.rev,
        seq: 0,
        deleted: event.type === "delete",
        data,
        clientId: request.clientId,
      });
    }
    const changes: Change[] = [];
    for (const [key, record] of staged) {
      record.seq = ++this.seq;
      this.records.set(key, record);
      const [collection, id] = JSON.parse(key) as [string, string];
      changes.push(this.toChange(collection, id, record));
    }
    if (changes.length > 0) this.broadcast(changes);
    return {
      ok: true,
      applied: request.events.map(({ eventId, rev }) => ({ eventId, rev })),
    };
  }

  /** A write by the server's own code, through the push path. */
  write(collection: string, id: string, data: Row | null) {
    const rev = (this.records.get(this.key(collection, id))?.rev ?? 0) + 1;
    const reply = this.push(
      {
        requestId: "server",
        events: [
          data
            ? { eventId: `server-${this.seq}`, collection, type: "create", id, data, rev }
            : { eventId: `server-${this.seq}`, collection, type: "delete", id, rev },
        ],
      },
      "socket",
    );
    this.pushes.pop();
    return reply;
  }

  toChange(collection: string, id: string, record: StoredRecord): Change {
    return {
      collection,
      id,
      seq: record.seq,
      rev: record.rev,
      deleted: record.deleted,
      ...(record.data && { data: record.data }),
    };
  }

  broadcast(changes: Change[]) {
    for (const socket of this.caughtUp) {
      if (changes.length > this.pokeAbove) socket.deliver({ type: "poke" });
      else
        socket.deliver({
          type: "changes",
          changes,
          checkpoints: positions(changes),
          hasMore: false,
        });
    }
  }

  changesAfter(checkpoints: Checkpoints) {
    return [...this.records]
      .map(([key, record]) => {
        const [collection, id] = JSON.parse(key) as [string, string];
        return this.toChange(collection, id, record);
      })
      .filter(
        (change) =>
          change.collection in checkpoints && change.seq > (checkpoints[change.collection] ?? 0),
      )
      .sort((a, b) => a.seq - b.seq);
  }

  page(checkpoints: Checkpoints): Extract<ServerMessage, { type: "changes" }> {
    const all = this.changesAfter(checkpoints);
    const changes = all.slice(0, this.pageSize);
    return {
      type: "changes",
      changes,
      checkpoints: positions(changes),
      hasMore: all.length > changes.length,
    };
  }

  onMessage(socket: FakeSocket, message: ClientMessage) {
    if (socket.closed) return;
    const authed = this.tokens.has(socket.protocols[1]!);
    switch (message.type) {
      case "auth":
        socket.protocols[1] = message.token;
        return;
      case "push":
        if (!authed) {
          socket.deliver({
            type: "push-result",
            requestId: message.requestId,
            reply: { ok: false, reason: "unauthenticated" },
          });
          return;
        }
        {
          const { type: _type, ...request } = message;
          const reply = this.push(request, "socket");
          if (this.loseNextReply) {
            this.loseNextReply = false;
            return;
          }
          socket.deliver({ type: "push-result", requestId: message.requestId, reply });
        }
        return;
      case "pull": {
        if (!authed) {
          socket.deliver({ type: "unauthenticated" });
          return;
        }
        if (message.count) {
          for (const collection of Object.keys(message.checkpoints)) {
            const total = this.changesAfter({
              [collection]: message.checkpoints[collection]!,
            }).length;
            socket.deliver({ type: "count", collection, total });
          }
        }
        const page = this.page(message.checkpoints);
        socket.deliver(page);
        if (!page.hasMore) {
          this.caughtUp.add(socket);
          socket.deliver({ type: "caught-up" });
        }
        return;
      }
      case "preview":
        socket.deliver({
          type: "preview",
          changes: this.preview(message.collections, message.limit),
        });
        return;
    }
  }

  preview(collections: Record<string, PreviewSort | null>, limit: number) {
    return Object.entries(collections).flatMap(([collection, sort]) => {
      const live = this.changesAfter({ [collection]: null }).filter((change) => !change.deleted);
      const sorted = sort
        ? live.sort((a, b) => {
            const order = String(a.data![sort.column]).localeCompare(String(b.data![sort.column]));
            return sort.direction === "asc" ? order : -order;
          })
        : live.reverse();
      return sorted.slice(0, limit);
    });
  }
}

function positions(changes: Change[]) {
  const checkpoints: Record<string, number> = {};
  for (const change of changes) checkpoints[change.collection] = change.seq;
  return checkpoints;
}
