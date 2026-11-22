import { exports } from "cloudflare:workers";
import {
  SUBPROTOCOL,
  type ClientMessage,
  type PushEvent,
  type PushReply,
  type ServerMessage,
} from "../src/server.ts";
import { token } from "./worker.ts";

const ORIGIN = "http://example.com";
/** The device the helpers push as, unless a test names another (`undefined` sends none). */
export const DEVICE = "device-a";
let counter = 0;

/** A fresh scope per test, so objects never share state. */
export function uniqueScope(): string {
  counter += 1;
  return `scope-${counter}-${crypto.randomUUID()}`;
}

export function listEvent(event: Partial<PushEvent> & Pick<PushEvent, "type" | "id">): PushEvent {
  counter += 1;
  return { eventId: `event-${counter}`, collection: "lists", rev: 1, ...event };
}

export function fetchApp(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(`${ORIGIN}${path}`, init);
}

export async function httpPush(
  scope: string,
  events: unknown,
  path = "/sync/push",
  clientId: unknown = DEVICE,
): Promise<PushReply> {
  const response = await fetchApp(path, {
    method: "POST",
    headers: { Authorization: token(scope) },
    body: JSON.stringify({ requestId: "r", clientId, events }),
  });
  return response.json();
}

export async function httpPull(scope: string, body: unknown): Promise<ServerMessage> {
  const response = await fetchApp("/sync/pull", {
    method: "POST",
    headers: { Authorization: token(scope) },
    body: JSON.stringify(body),
  });
  return response.json();
}

export type TestSocket = Awaited<ReturnType<typeof openSocket>>;

export async function openSocket(scope: string, expiresAt?: number, path = "/sync") {
  const response = await fetchApp(path, {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": `${SUBPROTOCOL}, ${token(scope, expiresAt)}`,
    },
  });
  const ws = response.webSocket!;
  ws.accept();
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  ws.addEventListener("message", (event) => {
    queue.push(event.data as string);
    wake?.();
  });
  const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve));
  return {
    response,
    ws,
    closed,
    send(message: ClientMessage | string) {
      ws.send(typeof message === "string" ? message : JSON.stringify(message));
    },
    async next(): Promise<ServerMessage> {
      while (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
      return JSON.parse(queue.shift()!) as ServerMessage;
    },
    /** Messages received and not read yet. */
    unread: () => queue.length,
  };
}

/** Pushes over an open socket and returns the `push-result` reply. */
export async function socketPush(
  socket: TestSocket,
  events: unknown,
  clientId: unknown = DEVICE,
): Promise<PushReply> {
  const requestId = crypto.randomUUID();
  socket.send({ type: "push", requestId, clientId, events } as ClientMessage);
  for (;;) {
    const message = await socket.next();
    if (message.type === "push-result" && message.requestId === requestId) return message.reply;
  }
}

/** Pulls every page and returns the messages up to `caught-up`. */
export async function pullAll(
  socket: TestSocket,
  message: Extract<ClientMessage, { type: "pull" }>,
) {
  const received: ServerMessage[] = [];
  let checkpoints = { ...message.checkpoints };
  for (;;) {
    socket.send({ ...message, checkpoints });
    for (;;) {
      const next = await socket.next();
      received.push(next);
      if (next.type === "changes") {
        checkpoints = { ...checkpoints, ...next.checkpoints };
        if (next.hasMore) break;
      }
      if (next.type === "caught-up") return received;
    }
    message = { ...message, count: false };
  }
}
