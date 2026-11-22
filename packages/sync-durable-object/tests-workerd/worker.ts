import {
  readSubprotocolToken,
  routeSyncRequest,
  SyncDurableObject,
  type SyncAuthentication,
} from "../src/server.ts";
import { defineRelations } from "drizzle-orm";
import migrations from "./drizzle/migrations.js";
import * as schema from "./schema.ts";

export const relations = defineRelations(schema, (r) => ({
  lists: { items: r.many.items() },
  items: { list: r.one.lists({ from: r.items.listId, to: r.lists.id }) },
}));

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_SYNC: DurableObjectNamespace<TestSyncObject>;
      PLAIN_SYNC: DurableObjectNamespace<PlainSyncObject>;
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
  return uid && expiresAt ? { principal: { uid }, expiresAt: Number(expiresAt) } : null;
}

/** Every hook set. `validate` refuses a list named "bad"; `onCommitted` throws on "boom". */
export class TestSyncObject extends SyncDurableObject<Cloudflare.Env, typeof relations> {
  migrations = migrations;
  relations = relations;
  collections = {
    lists: { table: schema.lists },
    items: { table: schema.items },
    notes: { table: schema.notes },
  };
  committed: { changes: unknown[]; source: string }[] = [];
  validated: unknown[] = [];

  override authenticate(value: string) {
    return Promise.resolve(verify(value));
  }

  override validate(input: Parameters<NonNullable<SyncDurableObject["validate"]>>[0]) {
    this.validated.push(input);
    if (input.event.data?.name === "bad") return { reject: "invalid-argument" as const };
    return undefined;
  }

  override onCommitted(input: { changes: unknown[]; source: string }) {
    this.committed.push(input);
    if (JSON.stringify(input.changes).includes("boom")) throw new Error("boom");
  }
}

/** No hooks, no relations. */
export class PlainSyncObject extends SyncDurableObject {
  migrations = migrations;
  collections = { lists: { table: schema.lists } };
}

/** The app's Worker: verifies the token, then routes. `/plain/…` goes to the hook-less object. */
export default {
  fetch(request, env) {
    const auth = verify(
      request.headers.has("Sec-WebSocket-Protocol")
        ? readSubprotocolToken(request)
        : request.headers.get("Authorization"),
    );
    if (!auth) return new Response(null, { status: 401 });
    const options = { scope: (auth.principal as { uid: string }).uid, ...auth };
    // One call per binding: a union of two typed namespaces is too deep to check.
    return new URL(request.url).pathname.startsWith("/plain")
      ? routeSyncRequest(request, { namespace: env.PLAIN_SYNC, ...options })
      : routeSyncRequest(request, { namespace: env.TEST_SYNC, ...options });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
