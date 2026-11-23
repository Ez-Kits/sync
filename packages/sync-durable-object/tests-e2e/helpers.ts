import { exports } from "cloudflare:workers";
import { createSyncClient, primaryKeyOf, recordIdOf } from "@ez-kits/sync-client-core";
import { vi } from "vite-plus/test";
import { atomicMemoryStore, fakeDBStorage } from "../../client-core/tests/helpers/storage.ts";
import {
  createDurableObjectSyncAdapter,
  PING,
  PONG,
  type FetchLike,
  type WebSocketConstructor,
} from "../src/client.ts";
import * as schema from "./schema.ts";
import { token } from "./worker.ts";

export const URL = "http://e2e.test/sync";

export const collections = [
  { name: "todos", adapterConfig: { table: schema.todos }, primaryField: "id" },
  { name: "notes", adapterConfig: { table: schema.notes }, primaryField: "id" },
  { name: "pairs", adapterConfig: { table: schema.pairs }, primaryField: ["a", "b"] },
  { name: "groups", adapterConfig: { table: schema.groups }, primaryField: "id" },
  { name: "members", adapterConfig: { table: schema.members }, primaryField: "id" },
] as const;

type Config = (typeof collections)[number];
type Row = Record<string, unknown>;

let counter = 0;
/** A fresh user per test, so tests never share an object. */
export function uniqueUser(): string {
  counter += 1;
  return `user-${counter}-${crypto.randomUUID()}`;
}

/** The app's Worker over HTTP, as `fetch` would reach it. */
export const fetchApp: FetchLike = (url, init) => exports.default.fetch(url, init);

/** What a device's sockets did (opens, close codes, JSON messages each way) and every push. */
export interface SocketLog {
  opened: number;
  closes: number[];
  sent: any[];
  received: any[];
  /** Socket and HTTP pushes in the order sent, with their reply once it came. */
  pushes: {
    via: "socket" | "http";
    requestId: string;
    clientId?: string;
    events: any[];
    reply?: any;
  }[];
  /** Pages received, over the socket or HTTP. */
  pages: { changes: any[]; checkpoints: Record<string, number>; hasMore: boolean }[];
  /** The checkpoints of every pull sent, over the socket or HTTP. */
  pulls: Record<string, number | null>[];
}

/**
 * A `WebSocket` whose upgrade goes through the app's Worker. A refused upgrade fails like a
 * browser socket: `error`, then `close` with 1006.
 */
export function workerSocket(
  log: SocketLog,
  beforeOpen: () => Promise<void> = async () => {},
): WebSocketConstructor {
  return class {
    private ws: WebSocket | undefined;
    private listeners = new Map<string, ((event: any) => void)[]>();
    private closed = false;

    constructor(url: string, protocols: string[]) {
      void exports.default
        .fetch(url, {
          headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": protocols.join(", ") },
        })
        .then(async (response) => {
          const ws = response.webSocket;
          if (!ws || this.closed) {
            this.emit("error", {});
            this.emit("close", { code: 1006 });
            return;
          }
          ws.accept();
          this.ws = ws;
          await beforeOpen();
          ws.addEventListener("message", (event) => {
            if (event.data !== PONG) {
              const message = JSON.parse(event.data as string);
              log.received.push(message);
              if (message.type === "changes") log.pages.push(message);
              if (message.type === "push-result") {
                const push = log.pushes.find(
                  (p) => p.via === "socket" && p.requestId === message.requestId,
                );
                push!.reply = message.reply;
              }
            }
            this.emit("message", { data: event.data });
          });
          ws.addEventListener("close", (event) => {
            log.closes.push(event.code);
            this.emit("close", { code: event.code });
          });
          log.opened += 1;
          this.emit("open", {});
        });
    }

    addEventListener(type: string, listener: (event: any) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    send(data: string) {
      if (data !== PING) {
        const message = JSON.parse(data);
        log.sent.push(message);
        if (message.type === "push") log.pushes.push({ via: "socket", ...message });
        if (message.type === "pull") log.pulls.push(message.checkpoints);
      }
      this.ws!.send(data);
    }

    close(code = 1000) {
      this.closed = true;
      this.ws?.close(code);
    }

    private emit(type: string, event: unknown) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  } as unknown as WebSocketConstructor;
}

/** `fetchApp` that logs pushes and pulls. */
function loggingFetch(log: SocketLog): FetchLike {
  return async (url, init) => {
    const response = await fetchApp(url, init);
    const body = JSON.parse(init.body);
    const reply: any = await response.json();
    if (url.endsWith("/push")) {
      const { requestId, clientId, events } = body;
      log.pushes.push({ via: "http", requestId, clientId, events, reply });
    } else {
      log.pulls.push(body.checkpoints);
      log.pages.push(reply);
    }
    return { ok: response.ok, status: response.status, json: async () => reply };
  };
}

/** In-memory rows per collection, keyed by record id, behind core's DB adapter contract. */
export function memoryDb(store = atomicMemoryStore()) {
  const tables = new Map<string, Map<string, Row>>(
    collections.map(({ name }) => [name, new Map()]),
  );
  const config = (name: string) => collections.find((c) => c.name === name)! as Config;
  const keyOfRow = (name: string, row: Row) =>
    recordIdOf(config(name), primaryKeyOf(config(name), row));
  const keyOf = (name: string, id: unknown) => recordIdOf(config(name), id);
  const db: any = {
    tables,
    dbStorage: fakeDBStorage(),
    localChangeStore: store,
    queryBuilder: tables,
    querySchema: { todos: {}, notes: {}, pairs: {}, groups: {}, members: {} },
    insert: async (name: string, row: Row) => {
      const key = keyOfRow(name, row);
      if (tables.get(name)!.has(key)) throw new Error(`duplicate ${key}`);
      tables.get(name)!.set(key, row);
    },
    update: async (name: string, row: Row) => {
      const key = keyOfRow(name, row);
      tables.get(name)!.set(key, { ...tables.get(name)!.get(key), ...row });
    },
    delete: vi.fn(async (name: string, id: unknown) => {
      tables.get(name)!.delete(keyOf(name, id));
    }),
    get: async (name: string, id: unknown) => tables.get(name)!.get(keyOf(name, id)),
    getMany: async (name: string) => [...tables.get(name)!.values()],
    transaction: async (fn: (tx: any, context: any) => Promise<unknown>) =>
      fn(db, { operations: db, native: undefined }),
    commitLocalMutation: async ({ mutate, persistOutboxEvent }: any) => {
      const context = { operations: db, native: db };
      await mutate(context);
      await persistOutboxEvent(context);
    },
  };
  return db;
}

/** A `WebSocket` that can't be created, as on a platform without one: the adapter polls. */
const NoSocket = class {
  constructor() {
    throw new Error("no WebSocket");
  }
} as unknown as WebSocketConstructor;

export type Mode = "socket" | "http";

export interface DeviceOptions {
  user: string;
  /** `"http"` forces polling, every 50 ms. Default: `"socket"`. */
  mode?: Mode;
  url?: string;
  /** Reuse a stopped device's outbox and checkpoints, as a restarted app would. */
  store?: ReturnType<typeof atomicMemoryStore>;
  db?: ReturnType<typeof memoryDb>;
  WebSocket?: WebSocketConstructor;
  /** Runs once a socket is accepted, before the client sees it open (and sends its pull). */
  beforeOpen?: () => Promise<void>;
  extra?: Record<string, unknown>;
}

/** One device: a real sync client with the real adapter, talking to the Worker. */
export function device({
  user,
  mode = "socket",
  url = URL,
  store,
  db = memoryDb(store),
  WebSocket,
  beforeOpen,
  extra,
}: DeviceOptions) {
  const auth = { token: token(user) };
  const sockets: SocketLog = {
    opened: 0,
    closes: [],
    sent: [],
    received: [],
    pushes: [],
    pages: [],
    pulls: [],
  };
  const getToken = vi.fn(() => auth.token);
  const syncAdapter = createDurableObjectSyncAdapter({
    url,
    collections,
    getToken,
    fetch: loggingFetch(sockets),
    WebSocket: mode === "http" ? NoSocket : (WebSocket ?? workerSocket(sockets, beforeOpen)),
    pollIntervalMs: 50,
  });
  const onSyncStatus = vi.fn();
  const client = createSyncClient({
    collections,
    dbAdapter: db,
    syncAdapter,
    onSyncStatus,
    ...extra,
  } as any) as any;
  const rows = (name: string) => Object.fromEntries(db.tables.get(name));
  const caughtUp = () => client.waitForPulled({ timeoutMs: 10_000 }) as Promise<void>;
  return { db, client, auth, getToken, sockets, onSyncStatus, rows, caughtUp };
}

/** Pushes `events` straight to the Worker over HTTP, as the device `clientId` would. */
export async function httpPush(user: string, events: unknown[], clientId?: string) {
  const response = await fetchApp(`${URL}/push`, {
    method: "POST",
    headers: { authorization: `Bearer ${token(user)}` },
    body: JSON.stringify({ requestId: "direct", clientId, events }),
  });
  return response.json();
}

/** The object's change log, pulled over HTTP from the start. */
export async function serverChanges(user: string) {
  const response = await fetchApp(`${URL}/pull`, {
    method: "POST",
    headers: { authorization: `Bearer ${token(user)}` },
    body: JSON.stringify({
      checkpoints: Object.fromEntries(collections.map(({ name }) => [name, null])),
    }),
  });
  return (
    (await response.json()) as {
      changes: { collection: string; id: string; rev: number; deleted: boolean; data?: Row }[];
    }
  ).changes;
}
