# Sync with Cloudflare Durable Objects

`@ez-kits/sync-durable-object` syncs your collections with a **Durable Object per scope**: one object, with its own SQLite database, per user (or team, or document). You own the server code. The object stores your rows in tables made from the same Drizzle schema the app uses, checks every write's revision, and sends live changes to every open device over a WebSocket.

```bash
npm install @ez-kits/sync-durable-object drizzle-orm@1.0.0-rc.5
npm install -D drizzle-kit@1.0.0-rc.5 wrangler
```

This guide goes from zero to syncing in eight steps. The [API reference](../api/sync-durable-object.md) lists every option.

## 1. One schema for client and server

Write your tables once, with Drizzle's SQLite builders, in a file both the app and the Worker import. The client uses them for its local tables; the server creates the same tables in the object.

```ts
// shared/schema.ts
import { defineRelations } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const lists = sqliteTable("lists", {
  id: text().primaryKey(),
  name: text().notNull(),
});

export const todos = sqliteTable("todos", {
  id: text().primaryKey(),
  listId: text("list_id")
    .notNull()
    .references(() => lists.id, { onDelete: "cascade" }),
  title: text().notNull(),
  done: integer().notNull().default(0),
});

export const relations = defineRelations({ lists, todos }, (r) => ({
  lists: { todos: r.many.todos() },
  todos: { list: r.one.lists({ from: r.todos.listId, to: r.lists.id }) },
}));
```

Rows travel with the Drizzle **property names** (`listId`), so client and server agree whatever the column names are. Keep `drizzle-orm` and `drizzle-kit` on the **same version** on both sides (`1.0.0-rc.5`).

Generate the server's migrations with drizzle-kit's `durable-sqlite` driver:

```ts
// drizzle.config.ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./shared/schema.ts",
  out: "./worker/drizzle",
});
```

```bash
npx drizzle-kit generate
```

This writes `worker/drizzle/migrations.js`, which imports one `.sql` file per migration. Run it again after every schema change; the object applies new migrations when it next starts. The app creates its own local tables as described in [Your database schema](database-schema.md).

## 2. The Durable Object

Subclass `SyncDurableObject` and name the synced collections. Their keys must be the collection names the app uses.

```ts
// worker/sync-object.ts
import { SyncDurableObject, type PushEvent } from "@ez-kits/sync-durable-object/server";
import { verifyToken } from "./auth";
import migrations from "./drizzle/migrations";
import { lists, relations, todos } from "../shared/schema";

export class SyncObject extends SyncDurableObject<Env, typeof relations> {
  migrations = migrations;
  relations = relations;
  collections = { lists: { table: lists }, todos: { table: todos } };

  // Checks the token of a refresh on the open socket (step 5).
  override authenticate(token: string) {
    return verifyToken(token);
  }

  // Optional: refuse a write for good. Runs inside the transaction, so no await.
  override validate({ event }: { event: PushEvent }) {
    if (typeof event.data?.title === "string" && event.data.title.length > 500) {
      return { reject: "invalid-argument" as const };
    }
    return undefined;
  }
}
```

The object handles pushes, pulls and sockets itself. Use `this.db` (Drizzle, with `db.query` typed by your relations) to read, and `this.write([...])` to change rows from your own code so that devices receive the change.

## 3. The Worker: authenticate, then route

The object trusts whoever routes to it, so your Worker verifies the token first. The client sends it next to the subprotocol on the WebSocket (`["ezsync", token]`) and as `Authorization: Bearer <token>` over HTTP.

```ts
// worker/index.ts
import { readSubprotocolToken, routeSyncRequest } from "@ez-kits/sync-durable-object/server";
import { verifyToken } from "./auth"; // { principal: { uid: string }, expiresAt } or null

export { SyncObject } from "./sync-object";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/sync")) return new Response(null, { status: 404 });

    const token = request.headers.has("Sec-WebSocket-Protocol")
      ? readSubprotocolToken(request)
      : request.headers.get("Authorization")?.replace(/^Bearer /, "");
    const auth = token ? await verifyToken(token) : null;
    if (!auth) return new Response(null, { status: 401 });

    return routeSyncRequest(request, {
      namespace: env.SYNC,
      scope: auth.principal.uid, // one object per user
      principal: auth.principal,
      expiresAt: auth.expiresAt,
    });
  },
} satisfies ExportedHandler<Env>;
```

- **`scope`** names the object, and so the database. Per user is the usual choice. For shared data, use a team or document id after checking the user belongs to it.
- **`principal`** is passed to `validate` and must be JSON.
- **`expiresAt`** (ms since the epoch) is when the socket stops accepting messages unless the client refreshes the token.
- The route can live under any path: the last segment (`/push`, `/pull`) picks the operation.

## 4. `wrangler.jsonc`

Bind the class and declare it as a **SQLite** Durable Object class:

```jsonc
{
  "name": "my-app",
  "main": "./worker/index.ts",
  "compatibility_date": "2026-11-01",
  "compatibility_flags": ["nodejs_compat"],
  // drizzle-kit's migrations import their SQL files as text.
  "rules": [{ "type": "Text", "globs": ["**/*.sql"], "fallthrough": true }],
  "durable_objects": {
    "bindings": [{ "name": "SYNC", "class_name": "SyncObject" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["SyncObject"] }],
}
```

`new_sqlite_classes` matters: the object's storage must be SQLite. It can't be changed for an existing class.

## 5. The client

Define the collections from the same tables and create the adapter:

```ts
import { createSyncClient } from "@ez-kits/sync-client-core";
import { defineDrizzleCollection } from "@ez-kits/sync-client-drizzle-adapter";
import { createDurableObjectSyncAdapter } from "@ez-kits/sync-durable-object/client";
import { lists, todos } from "../shared/schema";

const listsCollection = defineDrizzleCollection({ name: "lists", table: lists });
const todosCollection = defineDrizzleCollection({ name: "todos", table: todos });
const collections = [listsCollection, todosCollection];

const syncAdapter = createDurableObjectSyncAdapter({
  url: "https://my-app.example.com/api/sync",
  collections,
  getToken: () => auth.currentUser!.getIdToken(), // your auth provider
});

const client = createSyncClient({ collections, dbAdapter, syncAdapter });
client.startSync();
```

`getToken` is called on every connect and every HTTP request, so return a fresh token each time (most auth SDKs cache and refresh for you). Create the client after sign-in; when the user changes, `dispose()` it and create a new one on a new storage `key`.

**Token refresh on the open socket.** When the token passed in `expiresAt` runs out, the object answers the socket's next message with `unauthenticated`. The client calls `getToken()` and sends it in an `auth` message on the same socket, which the object checks with `authenticate`; nothing reconnects and nothing is pulled again. A socket that stays expired closes with `4001`, and the client reconnects with a fresh token.

## 6. How data moves

- **Pull** goes over one WebSocket per device. The client asks for pages after its checkpoints (one number per collection), 500 changes at a time, until `caught-up`. From then on every commit reaches the open sockets at once, as its changes, or as a `poke` when larger than `maxMessageBytes`, after which the client pulls again.
- **Push** goes over the socket while it is open and authenticated, and over `POST {url}/push` otherwise, for example while the socket is still connecting. Pushes are split into requests of up to 500 events and 1 MB (`pushLimits`).
- **Polling.** When the platform has no `WebSocket`, or 3 sockets in a row fail to open (a proxy that blocks them, say), the client pulls over `POST {url}/pull` every 30 s (`pollIntervalMs`) instead and tries a socket again every 5 minutes. The app sees no error.
- **Conflicts** are exact: every collection is revisioned, and the object refuses a write whose revision doesn't follow the stored one. Core then resolves it with your [conflict resolution](conflict-resolution.md).
- **Rejections** from `validate` (and unknown collections or columns) are permanent: core [parks the write](rejected-writes.md), and the rest of the batch still syncs.

## 7. Preview and count

On a device's first pull, show some rows before everything has downloaded, and report progress:

```ts
createDurableObjectSyncAdapter({
  // ...
  preview: { limit: 50, orderBy: { todos: { column: "title", direction: "asc" } } },
  countInitialPull: true,
});
```

- **`preview`** asks for up to `limit` rows of each collection that has no checkpoint yet, newest first unless `orderBy` names a column. They commit at once, the collection becomes `available`, and `hasRemoteData` is answered. The full pull follows on the same socket.
- **`countInitialPull`** has the object count the changes the pull delivers (one `count(*)` per collection), for `progress.total`.

Both need the socket: while polling over HTTP, there is no preview and no count. See [First sync and pull state](syncing.md#first-sync-and-pull-state).

## 8. Deleting an account

Call `deleteScope()` on the user's object, for example from an RPC method your account-deletion flow calls:

```ts
// in SyncObject
async deleteAccount() {
  await this.deleteScope();
}

// in the Worker, after checking the user really asked
await env.SYNC.getByName(uid).deleteAccount();
```

It wipes the object's storage, closes every socket with `4410` and refuses every later push and pull. Devices treat `4410` as permanent and stop syncing; dispose the client and delete the local database there.

## Testing

Run the Worker and the object in workerd with [`@cloudflare/vitest-plugin`](https://developers.cloudflare.com/workers/testing/vitest-integration/):

```ts
// vite.config.ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
```

Tests reach the Worker with `exports.default.fetch` from `cloudflare:workers`, open sockets by fetching with an `Upgrade: websocket` header, and inspect an object with `runInDurableObject` from `cloudflare:test`.

The package's own end-to-end tests are a working example: [`packages/sync-durable-object/tests-e2e`](../../packages/sync-durable-object/tests-e2e) runs real sync clients with this adapter against a real `SyncDurableObject` in workerd. Its `WebSocket` option is a small class that upgrades through the Worker, and it covers live changes, pokes, conflicts, rejections, token refresh, paging, cascades, polling and an eviction between commit and reply.

## Guarantees

- **Applied once.** Each push carries the device's `clientId`: a random id core keeps with the outbox, shared by every tab on that database and new after local storage is wiped. Each record remembers which device wrote its current revision. An event from that same device with a `rev` at or below the stored one is a resend, and is answered as applied without writing again. Core keeps each record's writes in order, holding later ones behind a refused one, so a refused or held write was never applied and its retry goes through normally. Nothing is kept per event, so there is nothing to prune.
- **All or nothing.** The events of one push request apply in one SQLite transaction. A conflict or a rejection rolls the whole request back.
- **Reply after commit.** A push is answered only after its transaction committed. A lost reply, or an object evicted before replying, leaves the push in the outbox; the retry is then answered as already applied.
- **No skipped pulls.** Every change gets the next sequence number in the same transaction that writes it, and the client saves a checkpoint only once it has applied everything up to it. A socket goes live in the same turn as its last page, so no commit falls between the pull and the live stream.
- **Deletes reach offline devices.** A delete leaves a tombstone, pulled like any other change. When a delete cascades through an `ON DELETE CASCADE` foreign key, the object tombstones the removed child rows too.
- **Convergence.** The object is the single writer of each scope and checks every revision, so every device ends up with the object's state.

## Limits

- **Tombstones are kept forever.** There is no compaction yet. The `reset-required` message that would tell a device its checkpoint is too old is reserved and not sent.
- **Only `CASCADE` is synced.** Rows changed by a foreign key's `SET NULL` or `SET DEFAULT` action change on the server but devices don't receive the change.
- **Tables with only key columns, or with generated columns, aren't handled.** A synced table needs at least one non-key column, and none generated.
- **Resends are recognized only while this device wrote last.** If a reply is lost and another device (or `write()`, `importRows()` or a cascade) writes the same record before the retry, the retry is answered `conflict`. A resolver that keeps the local version then writes the older value back over the newer one.
- **Some scans grow with the data.** Each push that deletes scans the live records of every cascading collection for removed rows.
- **Polling has no preview and no count.** Both need the socket.
- **`url` must be absolute in Node.** The browser resolves a relative URL against the page; Node's `fetch` and `WebSocket` don't.
- **An async `authenticate` can race.** While it awaits, the socket's next messages are handled with the old expiry, so a push sent right after a refresh can still be answered `unauthenticated` (and retried). Verify synchronously when you can.
- **`onCommitted` is awaited before the reply.** A slow hook delays every push answer. Send slow work to a queue instead.

## Billing and hibernation

The object uses the WebSocket **Hibernation API**: between messages, an object with only idle sockets is evicted from memory and isn't billed for duration, while its sockets stay open. The client's keep-alive `ping` (every 30 s) is answered by the runtime's auto-response with `pong`, without waking the object. The server sets no timers or alarms, so an idle scope costs nothing but storage.
