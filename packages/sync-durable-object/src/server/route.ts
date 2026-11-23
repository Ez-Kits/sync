import { SUBPROTOCOL } from "../protocol.ts";

/** Internal headers the Worker sets for the object; a client can't send them through. */
export const PRINCIPAL_HEADER = "x-ez-sync-principal";
export const EXPIRES_AT_HEADER = "x-ez-sync-expires-at";

export interface RouteSyncOptions {
  namespace: DurableObjectNamespace;
  /** The object's name, e.g. the user's id. */
  scope: string;
  /** Who the app's auth middleware verified; passed to the object's hooks. Must be JSON. */
  principal: unknown;
  /** When the verified token expires, in ms since the epoch. */
  expiresAt: number;
}

/**
 * Forwards a sync request the app already authenticated to the scope's object. The path's last
 * segment picks the operation (`…/push`, `…/pull`, anything else for the WebSocket), so the app
 * may mount the route anywhere.
 */
export function routeSyncRequest(request: Request, options: RouteSyncOptions): Promise<Response> {
  const url = new URL(request.url);
  const operation = /\/(push|pull)$/.exec(url.pathname)?.[0] ?? "";
  url.pathname = `/sync${operation}`;
  const headers = new Headers(request.headers);
  headers.set(PRINCIPAL_HEADER, JSON.stringify(options.principal));
  headers.set(EXPIRES_AT_HEADER, String(options.expiresAt));
  // The token rode next to the subprotocol; keep it out of the object.
  if (headers.has("Sec-WebSocket-Protocol")) headers.set("Sec-WebSocket-Protocol", SUBPROTOCOL);
  return options.namespace
    .getByName(options.scope)
    .fetch(url, { method: request.method, headers, body: request.body });
}

/** The token a client sent as `new WebSocket(url, [SUBPROTOCOL, token])`, for the app to verify. */
export function readSubprotocolToken(request: Request): string | null {
  const [protocol, token] = (request.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((part) => part.trim());
  return protocol === SUBPROTOCOL && token ? token : null;
}
