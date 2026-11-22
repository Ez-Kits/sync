import {
  readSubprotocolToken,
  routeSyncRequest,
  SyncDurableObject,
  type SyncAuthentication,
} from "../src/server.ts";
import migrations from "./migrations.ts";
import * as schema from "./schema.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      E2E_SYNC: DurableObjectNamespace<E2ESyncObject>;
      POKE_SYNC: DurableObjectNamespace<PokeSyncObject>;
    }
    interface GlobalProps {
      mainModule: typeof import("./worker.ts");
    }
  }
}

/** A test token: `<uid>:<expiresAt>`. */
export function token(uid: string, expiresAt = Date.now() + 60_000): string {
  return `${uid}:${expiresAt}`;
}

function verify(value: string | null | undefined): SyncAuthentication | null {
  const [uid, expiresAt] = (value ?? "").split(":");
  return uid && Number(expiresAt) > Date.now()
    ? { principal: { uid }, expiresAt: Number(expiresAt) }
    : null;
}

/** Todos whose commit already evicted the object once, by id; module state survives a reset. */
const evicted = new Set<string>();

/**
 * `validate` refuses a todo whose title is in `refused` ("bad"). Committing a todo titled "evict" resets the object
 * before it replies, once per id, as an eviction between the commit and the reply would.
 */
export class E2ESyncObject extends SyncDurableObject<Cloudflare.Env> {
  migrations = migrations;
  collections = {
    todos: { table: schema.todos },
    notes: { table: schema.notes },
    pairs: { table: schema.pairs },
    groups: { table: schema.groups },
    members: { table: schema.members },
  };

  /** Titles `validate` refuses; a test empties it to let a parked write through. */
  refused = new Set(["bad"]);

  override authenticate(value: string) {
    return verify(value);
  }

  override validate({ event }: Parameters<NonNullable<SyncDurableObject["validate"]>>[0]) {
    const title = event.data?.title;
    return typeof title === "string" && this.refused.has(title)
      ? { reject: "invalid-argument" as const }
      : undefined;
  }

  override onCommitted({ changes }: { changes: { id: string; data?: Record<string, unknown> }[] }) {
    const change = changes.find((c) => c.data?.title === "evict" && !evicted.has(c.id));
    if (!change) return;
    evicted.add(change.id);
    this.ctx.abort("test eviction");
  }
}

/** Small messages, so a commit of a few long rows reaches live sockets as a `poke`. */
export class PokeSyncObject extends E2ESyncObject {
  override maxMessageBytes = 4_000;
}

/** The app's Worker: verifies the token, then routes to the user's object; `/poke/…` to the small one. */
export default {
  fetch(request, env) {
    const auth = verify(
      request.headers.has("Sec-WebSocket-Protocol")
        ? readSubprotocolToken(request)
        : request.headers.get("Authorization")?.replace(/^Bearer /, ""),
    );
    if (!auth) return new Response(null, { status: 401 });
    const scope = (auth.principal as { uid: string }).uid;
    return new URL(request.url).pathname.startsWith("/poke")
      ? routeSyncRequest(request, { namespace: env.POKE_SYNC, scope, ...auth })
      : routeSyncRequest(request, { namespace: env.E2E_SYNC, scope, ...auth });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
