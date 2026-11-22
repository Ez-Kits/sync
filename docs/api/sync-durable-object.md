# `@ez-kits/sync-durable-object`

Syncs EzSync data with a **Cloudflare Durable Object** per scope (a user, a team, a document). The object keeps the scope's rows in SQLite tables made from your Drizzle schema, numbers every change with a per-object sequence, checks revisions itself and sends live changes over a hibernating WebSocket. Requires `drizzle-orm` `1.0.0-rc.5`.

```bash
npm install @ez-kits/sync-durable-object drizzle-orm@1.0.0-rc.5
```

| Entry point                           | Contents                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `@ez-kits/sync-durable-object/server` | `SyncDurableObject`, `routeSyncRequest` and the protocol. Runs in your Worker. Needs `drizzle-orm`.                      |
| `@ez-kits/sync-durable-object/client` | `createDurableObjectSyncAdapter` and the protocol. Runs in the app. Needs `@ez-kits/sync-client-core` and `drizzle-orm`. |

There is no root entry point; import from the one you use. The client entry never imports server code.

Guide: [Sync with Cloudflare Durable Objects](../guides/durable-objects.md).

---

## Server

### `SyncDurableObject<Env, Relations>`

An abstract `DurableObject` holding one scope's synced rows. Subclass it, export the subclass from your Worker and bind it as a SQLite-backed Durable Object.

```ts
import { SyncDurableObject } from "@ez-kits/sync-durable-object/server";
import migrations from "./drizzle/migrations";
import { relations, todos, lists } from "./schema";

export class SyncObject extends SyncDurableObject<Env, typeof relations> {
  migrations = migrations;
  relations = relations;
  collections = { todos: { table: todos }, lists: { table: lists } };
}
```

| Type parameter | Default          | Description                                                                        |
| -------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `Env`          | `unknown`        | Your Worker's bindings, as for `DurableObject<Env>`.                               |
| `Relations`    | `EmptyRelations` | `typeof relations`, from Drizzle's `defineRelations(schema, …)`. Types `db.query`. |

The library reserves the `/sync` paths of the object's `fetch` and every member whose name starts with `sync`. If you override `fetch` or `webSocketMessage`, call `super` for the library's requests.

#### Members you set

| Member        | Type                                     | Required | Description                                                                                                                                                                       |
| ------------- | ---------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrations`  | `{ migrations: Record<string, string> }` | yes      | The drizzle-kit output for the `durable-sqlite` driver (`import migrations from "./drizzle/migrations"`). Applied when the object starts, before any request.                     |
| `collections` | `Record<string, SyncCollection>`         | yes      | One `{ table }` per synced collection, keyed by the collection's name on the client. `table` is a Drizzle `sqliteTable`. Only these collections are pushed, pulled and previewed. |
| `relations`   | `Relations`                              | no       | `defineRelations(schema, …)`. Gives `db.query.<table>.findMany({ with })`. Not needed for sync itself.                                                                            |

Rows travel with your Drizzle **property names** (`createdAt`), not the column names (`created_at`). A record's id is the primary key as a string, or for a composite key the JSON array of its values in key order (`["l1",2]`), as `recordIdOf` in `@ez-kits/sync-client-core` builds it.

#### Settings

| Member            | Default     | Description                                                                                                          |
| ----------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `importBatchSize` | `500`       | Rows per transaction in `importRows()`.                                                                              |
| `maxMessageBytes` | `1_000_000` | A larger push is rejected with `too-large`; a larger commit reaches live sockets as a `poke` instead of its changes. |

Set a setting as a class field: `override maxMessageBytes = 500_000;`.

#### Hooks

| Hook                                      | Returns                                           | Description                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authenticate(token)`                     | `SyncAuthentication \| null`, or a promise of one | Checks the token of an `auth` message (a refresh on the open socket). `null` ignores it. A token for another principal than the socket's denies the socket: its pushes are refused with `permission-denied` and it stops receiving changes. Without the hook, refreshes are ignored and the socket closes once its first token expires. |
| `validate({ event, current, principal })` | `{ reject: RejectionCode } \| undefined`          | Refuses a write for good (from a device, or from `write()` with `principal: null`). `current` is the stored row, or `null`. Runs inside the write transaction: it must not await. A refusal rolls back the whole push.                                                                                                                  |
| `onCommitted({ changes, source })`        | `void \| Promise<void>`                           | Runs after a commit, outside the transaction, with the changes in `seq` order (cascade tombstones included). `source` is `"device"` or `"server"` (`write()`). Awaited before the push is answered. A throw is logged and ignored.                                                                                                      |

```ts
interface SyncAuthentication {
  principal: unknown; // must be JSON
  expiresAt: number; // ms since the epoch
}
```

#### `db`

`DrizzleSqliteDODatabase<Relations>`: Drizzle over the scope's SQLite, with `db.query` typed by `relations`.

```ts
const list = await this.db.query.lists.findFirst({ where: { id }, with: { todos: true } });
```

Read freely. **Write through `write()`**: a write through `db` changes the table but no device ever receives it, and its rows have no revision.

#### `write(events)`

```ts
write(events: SyncWriteEvent[]): Promise<{ rev: number; seq: number }[]>
```

Writes from your own code (a webhook, a scheduled job, an RPC method) through the same path as a device push: one transaction, `validate` called with `principal: null`, live sockets notified, `onCommitted` called with `source: "server"`. Each event takes the stored `rev` + 1, so it never conflicts. Throws `SyncRejectedError` when an event can't apply (unknown collection or column, a constraint, a `validate` refusal).

```ts
interface SyncWriteEvent {
  collection: string;
  type: "create" | "update" | "delete";
  id: RecordId;
  data?: Row; // the whole row for a create, the changed fields for an update
  deletedAt?: number;
}
```

#### `importRows(rows)`

```ts
importRows(rows: SyncImportRow[]): void
```

Bulk-loads rows from another backend, keeping the `rev` each had there, in transactions of `importBatchSize`. A refused row throws `SyncRejectedError` (its `index` counts from the start of `rows`) and rolls back its batch only. Live sockets get a `poke` and pull the rows. `validate` and `onCommitted` don't run.

```ts
interface SyncImportRow {
  collection: string;
  id: RecordId;
  data: Row;
  rev: number;
}
```

#### `deleteScope()`

```ts
deleteScope(): Promise<void>
```

Wipes the scope's storage, closes its sockets with `4410` and refuses every later request: a push with `scope-deleted`, an HTTP pull with status 410, a socket with an immediate `4410` close. Devices treat `4410` as permanent and stop syncing.

### `SyncRejectedError`

Thrown by `write()` and `importRows()`.

| Property | Type            | Description                                         |
| -------- | --------------- | --------------------------------------------------- |
| `index`  | `number`        | The refused event's or row's position in the input. |
| `code`   | `RejectionCode` | Why.                                                |

### `routeSyncRequest(request, options)`

```ts
routeSyncRequest(request: Request, options: RouteSyncOptions): Promise<Response>
```

Forwards a sync request **your Worker already authenticated** to the scope's object. The path's last segment picks the operation (`…/push`, `…/pull`, anything else opens the WebSocket), so the route can be mounted anywhere. The principal and expiry travel to the object in internal headers; the token next to the subprotocol is removed.

| Option      | Type                     | Description                                                                     |
| ----------- | ------------------------ | ------------------------------------------------------------------------------- |
| `namespace` | `DurableObjectNamespace` | The binding of your `SyncDurableObject` subclass.                               |
| `scope`     | `string`                 | The object's name, e.g. the user's id. One object, and one database, per scope. |
| `principal` | `unknown`                | Who you verified, passed to `validate` and compared on refresh. Must be JSON.   |
| `expiresAt` | `number`                 | When the verified token expires, in ms since the epoch.                         |

The object trusts these values. Never route a request you did not authenticate.

### `readSubprotocolToken(request)`

```ts
readSubprotocolToken(request: Request): string | null
```

The token a client sent as `new WebSocket(url, ["ezsync", token])`, for your Worker to verify. `null` when the subprotocol isn't `ezsync` or no token follows it.

### Server types

`SyncCollection` (`{ table: SQLiteTable }`), `SyncAuthentication`, `SyncWriteEvent`, `SyncImportRow`, `RouteSyncOptions`, and every [protocol](#protocol) export.

---

## Client

### `createDurableObjectSyncAdapter(options)`

A `SyncAdapter` for every collection given, passed to `createSyncClient({ syncAdapter })`. Every collection is revisioned: the server checks revisions, so conflicts are exact.

```ts
import { createDurableObjectSyncAdapter } from "@ez-kits/sync-durable-object/client";

const syncAdapter = createDurableObjectSyncAdapter({
  url: "https://app.example.com/api/sync",
  collections: [todosCollection, listsCollection],
  getToken: () => auth.currentUser!.getIdToken(),
});
```

| Option             | Type                                                         | Required | Description                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`              | `string`                                                     | yes      | Your sync route. The WebSocket opens on it; HTTP uses `{url}/push` and `{url}/pull`. Use an absolute URL outside the browser.                                                                                         |
| `collections`      | collection configs                                           | yes      | The configs given to `createSyncClient`; their names are the server's `collections` keys. With a Drizzle collection, pulled rows keep only the table's columns, and a single number key is decoded back to a number.  |
| `getToken`         | `() => string \| Promise<string>`                            | yes      | The token your Worker verifies. Called on every connect, every HTTP request and every refresh.                                                                                                                        |
| `preview`          | `{ limit: number; orderBy?: { [collection]: PreviewSort } }` | no       | On a collection's first pull on this device, ask for up to `limit` rows first, newest first by default or by `orderBy[collection]` (`{ column, direction: "asc" \| "desc" }`), so the app can show them. Socket only. |
| `countInitialPull` | `boolean`                                                    | no       | Ask the server how many changes the pull delivers, for `progress.total`. One `count(*)` per collection on the server. Socket only. Default `false`.                                                                   |
| `fetch`            | `FetchLike`                                                  | no       | Default: the global `fetch`.                                                                                                                                                                                          |
| `WebSocket`        | `WebSocketConstructor`                                       | no       | Default: the global `WebSocket`. Pass one in Node or tests.                                                                                                                                                           |
| `pushLimits`       | `Partial<PushLimits>`                                        | no       | `{ events, bytes }` per push request. Default: 500 events and 1,000,000 bytes. Keep `bytes` at or below the server's `maxMessageBytes`.                                                                               |
| `pollIntervalMs`   | `number`                                                     | no       | How often to pull over HTTP while a WebSocket can't be opened. Default: 30 s.                                                                                                                                         |
| `pingIntervalMs`   | `number`                                                     | no       | How often to send `ping` on the open socket, to keep it alive. Default: 30 s.                                                                                                                                         |

### Behaviour

- **Pull:** one WebSocket per device, opened with `[ "ezsync", token ]` as subprotocols. The client sends `preview` (when asked), then `pull` with one checkpoint per collection, and pulls again while a page says `hasMore`. After `caught-up` the socket is live: later commits arrive as `changes`, or as `poke` (the client pulls again). Checkpoints are saved only up to what was pulled, so a live commit after a `poke` never moves a checkpoint past changes not pulled yet. A checkpoint that isn't a number (saved by another adapter) pulls everything once.
- **Polling:** when `new WebSocket` throws, or 3 sockets in a row close before opening, the pull polls `{url}/pull` every `pollIntervalMs` instead, without reporting an error, and tries a socket again every 5 minutes. A socket that opens resets the count.
- **Push:** split by `pushLimits`. Each request goes over the socket while it is open and authenticated (answered by `push-result`, 30 s timeout), otherwise as `POST {url}/push` with `Authorization: Bearer <token>`. One path per attempt: a lost reply fails the push and core sends it again. Each request carries core's `clientId`, and the server answers an event as already applied when this device wrote the record's current revision and the event's `rev` is at or below it. This holds only while this device wrote last: if another device, `write()`, `importRows()` or a cascade wrote the record before the retry, the retry is a `conflict`, and a resolver that keeps the local version writes the older value back.
- **Replies:** `conflict` throws `PushConflictError` with the server's records, so core resolves it like a pulled conflict. `rejected` throws `PushRejectedError` with a `code`, which core [parks](../guides/rejected-writes.md). `unauthenticated` refreshes the token and throws a temporary error. A non-2xx HTTP status is a temporary error.
- **Tokens:** on an `unauthenticated` message the client calls `getToken()` and sends `auth` on the same socket. A close with `4001` is temporary: core reconnects with a fresh token.
- **Scope deleted:** a close with `4410` is reported as a permanent error with `code: "scope-deleted"`.

### Client types

| Type                              | Description                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `DurableObjectSyncAdapterOptions` | The options above.                                                              |
| `PushLimits`                      | `{ events: number; bytes: number }`.                                            |
| `FetchLike`                       | The part of `fetch` the adapter uses.                                           |
| `WebSocketConstructor`            | `new (url: string, protocols: string[]) => WebSocketLike`.                      |
| `WebSocketLike`                   | `send`, `close` and `addEventListener` for `open`, `message`, `error`, `close`. |

---

## Protocol

Exported from both entry points.

| Constant                | Value               | Meaning                                                                                            |
| ----------------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| `SUBPROTOCOL`           | `"ezsync"`          | The WebSocket subprotocol. The token rides next to it: `new WebSocket(url, [SUBPROTOCOL, token])`. |
| `CLOSE_UNAUTHENTICATED` | `4001`              | The token expired and no `auth` refreshed it. **Temporary**: reconnect with a fresh token.         |
| `CLOSE_SCOPE_DELETED`   | `4410`              | The scope was deleted. **Permanent**.                                                              |
| `PING` / `PONG`         | `"ping"` / `"pong"` | Keep-alive. The object answers `ping` with `pong` without waking.                                  |

| Type              | Description                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `PushEvent`       | `{ eventId, collection, type, id, data?, rev, deletedAt? }`. `rev` is the stored revision + 1. `eventId` names the event in replies.   |
| `PushRequest`     | `{ requestId, clientId?, events }`. All events apply in one transaction, or none do. Without `clientId`, a resend is a `conflict`.     |
| `PushReply`       | `{ ok: true, applied }`, or `ok: false` with `reason` `"conflict"` (`records`), `"rejected"` (`index`, `code`) or `"unauthenticated"`. |
| `RejectionCode`   | `"invalid-argument"`, `"unknown-collection"`, `"unknown-column"`, `"scope-deleted"`, `"permission-denied"`, `"too-large"`.             |
| `ConflictRecord`  | The server's state of a conflicting record: `{ collection, id, rev, data?, deleted }`.                                                 |
| `Change`          | A pulled change: `{ collection, id, seq, rev, deleted, data? }`. `data` is the full row.                                               |
| `Checkpoints`     | `Record<string, number \| null>`: per collection, the last `seq` applied; `null` before the first pull.                                |
| `PreviewSort`     | `{ column, direction: "asc" \| "desc" }`.                                                                                              |
| `ClientMessage`   | `pull`, `preview`, `auth`, `push`.                                                                                                     |
| `ServerMessage`   | `changes`, `caught-up`, `poke`, `count`, `push-result`, `preview`, `unauthenticated`, `reset-required` (reserved).                     |
| `Row`, `RecordId` | A row without `rev`; a record id string.                                                                                               |

Over HTTP, `POST {url}/push` takes a bare `PushRequest` and answers a `PushReply` (with status 200, conflicts and rejections included), and `POST {url}/pull` takes `{ checkpoints }` and answers a `changes` message.
