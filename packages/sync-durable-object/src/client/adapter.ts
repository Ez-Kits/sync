import {
  PushConflictError,
  PushRejectedError,
  type CollectionConfigMap,
  type CollectionNames,
  type PullOptions,
  type SyncAdapterFor,
} from "@ez-kits/sync-client-core";
import {
  CLOSE_SCOPE_DELETED,
  PING,
  PONG,
  SUBPROTOCOL,
  type Change,
  type Checkpoints,
  type ClientMessage,
  type PreviewSort,
  type PushReply,
  type PushRequest,
  type RejectionCode,
  type ServerMessage,
} from "../protocol.ts";
import {
  chunkEvents,
  createRecordReader,
  toPushEvent,
  type AnyCollection,
  type AnyEvent,
  type PushLimits,
} from "./events.ts";

/** The part of `WebSocket` the adapter uses. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number): void;
  addEventListener(type: "open" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
}

export type WebSocketConstructor = new (url: string, protocols: string[]) => WebSocketLike;

/** The part of `fetch` the adapter uses. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface DurableObjectSyncAdapterOptions<C extends CollectionConfigMap> {
  /** The app's sync route. The WebSocket opens on it; HTTP uses `{url}/push` and `{url}/pull`. */
  url: string;
  /** The collection configs given to `createSyncClient`; their names are the server's. */
  collections: C;
  /** The token the app's Worker verifies. Called on connect and on every refresh. */
  getToken: () => string | Promise<string>;
  /**
   * On a collection's first pull on this device, ask for up to `limit` rows first (newest
   * first by default, or by `orderBy[collection]`) so the app can show them.
   */
  preview?: { limit: number; orderBy?: Partial<Record<CollectionNames<C>, PreviewSort>> };
  /** Ask the server how many changes the pull delivers, for `progress.total`. */
  countInitialPull?: boolean;
  /** Default: the global `fetch`. */
  fetch?: FetchLike;
  /** Default: the global `WebSocket`. */
  WebSocket?: WebSocketConstructor;
  /** Default: 500 events and 1,000,000 bytes per push request. */
  pushLimits?: Partial<PushLimits>;
  /** How often to pull over HTTP when a WebSocket can't be opened. Default: 30 s. */
  pollIntervalMs?: number;
  /** How often to send `PING` on the open socket, to keep it alive. Default: 30 s. */
  pingIntervalMs?: number;
}

/** The globals used here, typed here since the package compiles without DOM or Node types. */
const platform = globalThis as unknown as {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(timer: unknown): void;
  fetch?: FetchLike;
  WebSocket?: WebSocketConstructor;
};

const PUSH_TIMEOUT_MS = 30_000;
/** Sockets in a row that close or fail before opening, before the pull polls instead. */
const OPEN_FAILURES_BEFORE_POLLING = 3;
/** While polling, how often to try a socket again. */
const SOCKET_RETRY_MS = 5 * 60_000;

type ChangesMessage = Extract<ServerMessage, { type: "changes" }>;

interface Connection {
  send(message: ClientMessage): void;
  /** False from an `unauthenticated` message until the `auth` that answers it. */
  authed: boolean;
  /** Socket pushes waiting for their `push-result`, by `requestId`. */
  pending: Map<string, { resolve: (reply: PushReply) => void; reject: (error: Error) => void }>;
}

function rejected(code: RejectionCode) {
  return Object.assign(new PushRejectedError(`The sync server rejected the push (${code}).`), {
    code,
  });
}

/**
 * Create a sync adapter for a Durable Object per scope, served by `./server`
 * (`createSyncClient({ syncAdapter })`). Revisions are always on.
 */
export function createDurableObjectSyncAdapter<const C extends CollectionConfigMap>(
  options: DurableObjectSyncAdapterOptions<C>,
): SyncAdapterFor<C, number> {
  const {
    url,
    getToken,
    preview,
    countInitialPull = false,
    pollIntervalMs = 30_000,
    pingIntervalMs = 30_000,
  } = options;
  const collections = options.collections as readonly AnyCollection[];
  const names = collections.map(({ name }) => String(name));
  const configs = new Map(collections.map((config) => [String(config.name), config]));
  const readers = new Map(
    collections.map((config) => [String(config.name), createRecordReader(config)]),
  );
  const limits: PushLimits = { events: 500, bytes: 1_000_000, ...options.pushLimits };
  const toEvent = (change: Change) => readers.get(change.collection)!(change);

  /** The open, authenticated socket of the current pull stream, if any. */
  let live: Connection | undefined;
  let requests = 0;
  /** Sockets in a row that never opened, across pull streams. */
  let failedOpens = 0;

  const post = async (path: string, body: unknown) => {
    const fetchImpl = options.fetch ?? platform.fetch!;
    const response = await fetchImpl(`${url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${await getToken()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`The sync server answered ${response.status}.`);
    return response.json();
  };

  const refreshToken = async () => {
    const token = await getToken();
    if (!live) return;
    live.send({ type: "auth", token });
    live.authed = true;
  };

  /** Forget a closed socket and fail its pushes; their events stay in the outbox. */
  const drop = (connection: Connection) => {
    if (live === connection) live = undefined;
    for (const { reject } of connection.pending.values()) {
      reject(new Error("The sync socket closed before the push was answered."));
    }
    connection.pending.clear();
  };

  const pushOverSocket = (connection: Connection, request: PushRequest) =>
    new Promise<PushReply>((resolve, reject) => {
      const timer = platform.setTimeout(() => {
        connection.pending.delete(request.requestId);
        reject(new Error("The push got no reply in time."));
      }, PUSH_TIMEOUT_MS);
      const settle =
        <T>(fn: (value: T) => void) =>
        (value: T) => {
          platform.clearTimeout(timer);
          fn(value);
        };
      connection.pending.set(request.requestId, {
        resolve: settle(resolve),
        reject: settle(reject),
      });
      connection.send({ type: "push", ...request });
    });

  const pull = async (pullOptions: PullOptions<any, any, number>) => {
    const { commitChanges, onError, onCaughtUp, onPreviewed, onCount } = pullOptions;
    // A checkpoint that isn't a number (a Firestore one, after switching adapters) pulls
    // everything once.
    const saved: Checkpoints = Object.fromEntries(
      names.map((name) => {
        const checkpoint: unknown = pullOptions.checkpoint?.[name];
        return [name, typeof checkpoint === "number" ? checkpoint : null];
      }),
    );
    const commit = (changes: Change[], checkpoint: Record<string, number>) => {
      Object.assign(saved, checkpoint);
      commitChanges({ changes: changes.map(toEvent), checkpoint });
    };

    let stopped = false;
    let caughtUp = false;
    /** Stops the current socket or poll. */
    let stopCurrent: () => void;
    const reportCaughtUp = () => {
      if (caughtUp) return;
      caughtUp = true;
      onCaughtUp?.();
    };

    /** Pulls over HTTP, and tries a socket again every {@link SOCKET_RETRY_MS}. */
    const poll = () => {
      let active = true;
      let timer: unknown;
      const run = async () => {
        try {
          const page = (await post("/pull", {
            type: "pull",
            checkpoints: { ...saved },
          })) as ChangesMessage;
          if (!active) return;
          commit(page.changes, page.checkpoints);
          if (page.hasMore) {
            void run();
            return;
          }
          reportCaughtUp();
          timer = platform.setTimeout(run, pollIntervalMs);
        } catch (error) {
          if (active) onError?.(error);
        }
      };
      const retry = platform.setTimeout(() => {
        stopCurrent();
        connect().catch((error: unknown) => {
          if (!stopped) onError?.(error);
        });
      }, SOCKET_RETRY_MS);
      stopCurrent = () => {
        active = false;
        platform.clearTimeout(timer);
        platform.clearTimeout(retry);
      };
      void run();
    };

    const connect = async () => {
      const token = await getToken();
      if (stopped) return;
      let socket: WebSocketLike;
      try {
        const WebSocketImpl = options.WebSocket ?? platform.WebSocket!;
        socket = new WebSocketImpl(url, [SUBPROTOCOL, token]);
      } catch {
        poll();
        return;
      }

      let opened = false;
      /** The socket failed, or this stream stopped using it: ignore what it sends. */
      let done = false;
      let ping: unknown;
      // A pull is in flight, until `caught-up`. `changes` doesn't say whether it's a page or a
      // live commit, so meanwhile only a page that asks for more saves its checkpoint, and
      // `caught-up` saves the highest seen: a live commit after a `poke` never saves a
      // checkpoint past the poked changes before they're pulled.
      let paging = true;
      const seen: Record<string, number> = {};
      let previewing: string[] = [];
      const connection: Connection = {
        send: (message) => socket.send(JSON.stringify(message)),
        authed: true,
        pending: new Map(),
      };
      const release = () => {
        platform.clearInterval(ping);
        drop(connection);
      };
      const stopSocket = () => {
        done = true;
        release();
        socket.close();
      };
      stopCurrent = stopSocket;
      const fail = (error: unknown) => {
        if (done) return;
        done = true;
        onError?.(error);
      };
      /** Polls instead after {@link OPEN_FAILURES_BEFORE_POLLING} sockets in a row never opened. */
      const failSocket = (error: unknown) => {
        if (done) return;
        if (!opened && ++failedOpens >= OPEN_FAILURES_BEFORE_POLLING) {
          stopSocket();
          poll();
          return;
        }
        fail(error);
      };
      const sendPull = (count = false) =>
        connection.send({ type: "pull", checkpoints: { ...saved }, ...(count && { count }) });

      const handle = (message: ServerMessage) => {
        switch (message.type) {
          case "changes":
            for (const [name, seq] of Object.entries(message.checkpoints)) {
              seen[name] = Math.max(seen[name] ?? 0, seq);
            }
            commit(message.changes, !paging || message.hasMore ? message.checkpoints : {});
            if (message.hasMore) sendPull();
            break;
          case "caught-up":
            paging = false;
            commit([], { ...seen });
            reportCaughtUp();
            break;
          case "poke":
            // A pull already in flight is answered after the poked commit.
            if (paging) break;
            paging = true;
            sendPull();
            break;
          case "count":
            onCount?.({ collection: message.collection, total: message.total });
            break;
          case "preview":
            commitChanges({
              changes: message.changes.map(toEvent),
              checkpoint: {},
              preview: true,
            });
            for (const name of previewing) {
              const hasData = message.changes.some(
                (change) => change.collection === name && !change.deleted,
              );
              onPreviewed?.({ collection: name, hasData });
            }
            break;
          case "push-result":
            connection.pending.get(message.requestId)?.resolve(message.reply);
            connection.pending.delete(message.requestId);
            break;
          case "unauthenticated":
            connection.authed = false;
            // The server drops the message it answers this way. A pull still in flight was that
            // message (an earlier one would have been answered first), so ask again after `auth`.
            refreshToken()
              .then(() => {
                if (paging && !done) sendPull();
              })
              .catch(fail);
            break;
          // shortcut: `reset-required` is reserved and not sent yet; handle it with compaction.
        }
      };

      socket.addEventListener("open", () => {
        opened = true;
        failedOpens = 0;
        live = connection;
        ping = platform.setInterval(() => socket.send(PING), pingIntervalMs);
        previewing = preview ? names.filter((name) => saved[name] === null) : [];
        if (previewing.length > 0) {
          const orderBy: Partial<Record<string, PreviewSort>> = preview!.orderBy ?? {};
          connection.send({
            type: "preview",
            collections: Object.fromEntries(
              previewing.map((name) => [name, orderBy[name] ?? null]),
            ),
            limit: preview!.limit,
          });
        }
        sendPull(countInitialPull);
      });
      socket.addEventListener("message", (event) => {
        if (done || event.data === PONG) return;
        try {
          handle(JSON.parse(String(event.data)) as ServerMessage);
        } catch (error) {
          fail(error);
        }
      });
      socket.addEventListener("error", () => failSocket(new Error("The sync socket failed.")));
      socket.addEventListener("close", ({ code }) => {
        release();
        failSocket(
          code === CLOSE_SCOPE_DELETED
            ? Object.assign(new Error("The sync scope was deleted."), {
                permanent: true,
                code: "scope-deleted",
              })
            : new Error(`The sync socket closed (${code}).`),
        );
      });
    };

    if (failedOpens >= OPEN_FAILURES_BEFORE_POLLING) poll();
    else await connect();
    return () => {
      stopped = true;
      stopCurrent();
    };
  };

  const adapter = {
    collections: names,
    revisionedCollections: names,
    pull,
    push: async ({
      events,
      clientId,
      commitChanges,
    }: {
      events: AnyEvent[];
      clientId?: string;
      commitChanges: (options: { events: AnyEvent[] }) => Promise<void>;
    }) => {
      const pushEvents = events.map((event) =>
        toPushEvent(configs.get(String(event.collection))!, event),
      );
      for (const { start, end, tooLarge } of chunkEvents(pushEvents, limits)) {
        if (tooLarge) throw rejected("too-large");
        requests += 1;
        const request = {
          requestId: String(requests),
          clientId,
          events: pushEvents.slice(start, end),
        };
        // One path per attempt: a lost socket reply fails the push, and core sends it again.
        const reply = live?.authed
          ? await pushOverSocket(live, request)
          : ((await post("/push", request)) as PushReply);
        if (reply.ok) {
          await commitChanges({ events: events.slice(start, end) });
          continue;
        }
        if (reply.reason === "conflict") {
          throw new PushConflictError(
            reply.records.map((record) => readers.get(record.collection)!(record)),
          );
        }
        if (reply.reason === "rejected") throw rejected(reply.code);
        await refreshToken();
        throw new Error("The sync token expired; the push is retried with a fresh one.");
      }
    },
  };
  return adapter as unknown as SyncAdapterFor<C, number>;
}
