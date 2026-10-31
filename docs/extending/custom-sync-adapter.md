# Custom sync adapter

A **sync adapter** connects EzSync to a backend. It is an object with two functions:

```ts
import type { SyncAdapter } from "@ez-kits/sync-client-core";

const syncAdapter: SyncAdapter<DataMap> = {
  pull({ checkpoint, commitChanges, onError }) {
    // Start listening for remote changes after `checkpoint`.
    // Call commitChanges({ changes, checkpoint }) for each batch.
    // Return a function that stops listening.
  },
  async push({ events, commitChanges }) {
    // Send `events` to the backend. Once it has saved them, await commitChanges({ events }).
  },
};
```

EzSync does everything else: the outbox, ordering, retries, conflict handling, checkpoints, multiple tabs. This page explains the contract, then builds a complete adapter for a REST API.

If a client-level adapter does not sync every collection, list the ones it does in `collections: ["todos", "projects"]`. It is then pushed the events of those only, and writes to the others stay local. Without the list it is pushed the events of every collection that has no adapter of its own, and must acknowledge them all: an event it skips stays in the outbox and is sent again on every push.

## The contract

### `pull(options)`

EzSync calls `pull` when sync starts (in the leader tab), and again after a failure.

| Option          | What it is                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkpoint`    | `{ [collection]: checkpoint }`: where the last saved pull stopped, per collection. A collection without a checkpoint starts from the beginning. |
| `commitChanges` | Call it with `{ changes, checkpoint }` for every batch of remote changes. `checkpoint` is the new position of the collections in the batch.     |
| `onError`       | Call it when the listener fails (network error, permission error). EzSync stops this pull and calls `pull` again later, with backoff.           |

Rules:

1. **Start from the `checkpoint` you are given.** Not from a cursor you kept from an earlier `pull` call: that earlier batch may have failed to commit.
2. **Return a cleanup function that stops everything** (timers, sockets, listeners). EzSync calls it on `stopSync()`, when the tab loses leadership, and before retrying.
3. **Each change is an event** of a collection:
   - `{ type: "create" | "update", collection, data }`: `data` must contain the collection's **primary key**. Creates and updates are both applied as an upsert (update if the row exists, insert if not), so send the **full record** whenever you can.
   - `{ type: "delete", collection, id, deletedAt? }`.
4. **Checkpoints must be safe to resume from.** Changes with equal cursor values, and later updates of an already pulled record, must still be delivered. Prefer a server-assigned, strictly increasing cursor (a sequence number, or a timestamp plus id).
5. `commitChanges` returns nothing. EzSync queues batches and commits each, with its checkpoint, in one transaction. If one fails, EzSync calls your cleanup, drops later queued batches and calls `pull` again from the last saved checkpoint.
6. The checkpoint is stored as a string with `JSON.stringify` by default. If yours is not plain JSON, tell users to pass `checkpoint: { serialize, deserialize }` to the client.

### `push(options)`

EzSync calls `push` with pending outbox events, oldest first, **one push at a time**.

| Option          | What it is                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `events`        | The local writes to send, in commit order. Each has an `eventId`, unique per write.                            |
| `commitChanges` | `await commitChanges({ events })` for events the backend **durably saved**. That removes them from the outbox. |

Rules:

1. **Resolve only after the backend saved the events**, and acknowledge only those. You may acknowledge in several steps (e.g. one call per batch you send) to make progress visible.
2. **Await `commitChanges`.** The next push reads the outbox after it settles. If it rejects, the push fails and is retried.
3. **Be idempotent.** After a network error, the same events can be pushed again even though the server already saved them. Use `eventId` (or idempotent writes like "set the record to this value") so a repeat is harmless.
4. **Keep the order** of events for the same record.
5. **Throw to fail.** See [Errors](#errors).

### Errors

| You throw...                                              | EzSync does                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PushRejectedError` (or any error with `permanent: true`) | The backend refused the write and would refuse it again (validation, permissions). EzSync splits the push into halves until it finds the refused events, pushes the others, and **parks** the refused ones (see [Rejected writes](../guides/rejected-writes.md)). |
| Anything else                                             | A temporary failure. EzSync retries the push with exponential backoff, re-sending whatever is still in the outbox.                                                                                                                                                |

Mark an error permanent **only** when resending the same data cannot succeed until something changes (rules, sign-in, data). Network errors, timeouts, rate limits, server errors and expired tokens are temporary. When in doubt, do not mark it permanent: a wrongly retried write is just delayed, while a wrongly parked one waits until the next retry.

For the narrowing to work, a push request should be **all-or-nothing**: if the backend refuses one event in a request, it saves none of them.

## Example: a REST API

The backend in this example has two endpoints:

```
GET  /sync/<collection>?since=<cursor>
     → 200 { "changes": [{ "id": "1", "deleted": false, "data": { ... } }, ...], "cursor": "42" }

POST /sync
     body { "events": [{ "eventId", "collection", "type", "id", "data" }, ...] }
     → 200 when every event is saved (events with a known eventId are skipped)
     → 403 / 422 when an event is refused (nothing is saved)
```

The cursor is an opaque string from the server, for example the last change's sequence number. The adapter polls for changes. A WebSocket or server-sent events version has the same shape: open the connection in `pull`, call `commitChanges` per message, close it in the cleanup.

```ts
// rest-sync-adapter.ts
import {
  PushRejectedError,
  type ChangeBusEventDataMap,
  type PullCommitChangesOptions,
  type SyncAdapter,
} from "@ez-kits/sync-client-core";

/** One change, as the server sends it. */
interface RemoteChange {
  id: string;
  deleted: boolean;
  /** The full record; absent for deletes. */
  data?: Record<string, unknown>;
  deletedAt?: number;
}

export interface RestSyncAdapterOptions<N extends string> {
  baseUrl: string;
  /** The collections to sync; each maps to `/sync/<name>`. */
  collections: readonly N[];
  /** The primary key field of every collection. Default `"id"`. */
  primaryKey?: string;
  /** How often to poll for remote changes. Default 5 seconds. */
  pollIntervalMs?: number;
  /** Headers for every request, e.g. an auth token. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  fetch?: typeof fetch;
}

/** The checkpoint of a collection is the server's opaque cursor string. */
export type RestCheckpoint = string;

export function createRestSyncAdapter<C extends ChangeBusEventDataMap>(
  options: RestSyncAdapterOptions<keyof C & string>,
): SyncAdapter<C, keyof C & string, RestCheckpoint> {
  type N = keyof C & string;
  type PulledEvent = PullCommitChangesOptions<C, N, RestCheckpoint>["changes"][number];

  const { baseUrl, collections, primaryKey = "id", pollIntervalMs = 5000 } = options;
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = { "content-type": "application/json", ...(await options.headers?.()) };
    return (options.fetch ?? fetch)(`${baseUrl}${path}`, { ...init, headers });
  };

  const toEvent = (collection: N, change: RemoteChange): PulledEvent =>
    (change.deleted
      ? { type: "delete", collection, id: change.id, deletedAt: change.deletedAt }
      : // Creates and updates are both upserts: send the full record, with its primary key.
        {
          type: "update",
          collection,
          data: { ...change.data, [primaryKey]: change.id },
        }) as PulledEvent;

  return {
    pull({ checkpoint, commitChanges, onError }) {
      // Pull rule 1: start from the checkpoint EzSync hands over.
      const cursors = { ...checkpoint } as Partial<Record<N, RestCheckpoint>>;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const pollOnce = async () => {
        for (const collection of collections) {
          const since = encodeURIComponent(cursors[collection] ?? "");
          const response = await request(`/sync/${collection}?since=${since}`);
          if (!response.ok) throw new Error(`Pull of ${collection} failed with ${response.status}`);
          const body = (await response.json()) as { changes: RemoteChange[]; cursor: string };
          if (stopped || body.changes.length === 0) continue;
          cursors[collection] = body.cursor;
          // The batch and its checkpoint are committed together, in one transaction.
          commitChanges({
            changes: body.changes.map((change) => toEvent(collection, change)),
            checkpoint: { [collection]: body.cursor } as Partial<Record<N, RestCheckpoint>>,
          });
        }
      };

      const loop = async () => {
        try {
          await pollOnce();
        } catch (error) {
          // EzSync stops this pull and starts a new one from the saved checkpoint, with backoff.
          if (!stopped) onError?.(error);
          return;
        }
        if (!stopped) timer = setTimeout(loop, pollIntervalMs);
      };
      void loop();

      // Pull rule 2: the cleanup stops everything this pull started.
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    },

    async push({ events, commitChanges }) {
      const body = events.map((event) => ({
        eventId: event.eventId, // push rule 3: lets the server skip a write it already saved
        collection: event.collection,
        type: event.type,
        id:
          event.type === "delete" ? event.id : (event.data as Record<string, unknown>)[primaryKey],
        data: event.type === "delete" ? undefined : event.data,
      }));
      const response = await request("/sync", {
        method: "POST",
        body: JSON.stringify({ events: body }),
      });

      // Refused for good: the same events would be refused again.
      if (response.status === 403 || response.status === 422) {
        throw new PushRejectedError(`The server refused the write (${response.status}).`);
      }
      // Anything else that is not a success is retried with backoff.
      if (!response.ok) throw new Error(`Push failed with ${response.status}`);

      // Push rule 1: acknowledge only what the server saved. This removes it from the outbox.
      await commitChanges({ events });
    },
  };
}
```

### Use it

The adapter is generic over the collections' **data map**. Give it explicitly; it is computed from your collections:

```ts
import {
  createSyncClient,
  type ChangeBusEventDataMapFromCollectionConfigMap,
} from "@ez-kits/sync-client-core";
import { createRestSyncAdapter } from "./rest-sync-adapter";

type DataMap = ChangeBusEventDataMapFromCollectionConfigMap<[typeof todosCollection]>;

const client = createSyncClient({
  collections: [todosCollection],
  dbAdapter,
  syncAdapter: createRestSyncAdapter<DataMap>({
    baseUrl: "https://api.example.com",
    collections: ["todos"],
    headers: async () => ({ authorization: `Bearer ${await getToken()}` }),
  }),
});

client.startSync();
```

List every collection in the tuple type, in the same order as `collections`: `[typeof todosCollection, typeof projectsCollection]`.

### What the server must do

- **Pull:** return changes with a cursor greater than `since`, in cursor order, with the cursor of the last returned change. Include deletes (keep tombstones, or a change log) so offline devices learn about them.
- **Push:** apply the events of a request in order and atomically; skip events whose `eventId` was already applied; return `403` / `422` (and save nothing) when one is refused.
- **Authorize** every request. EzSync sends whatever the user wrote locally.

## A fake adapter for tests

An in-memory adapter: it records pushes and lets a test deliver remote changes.

```ts
// memory-sync-adapter.ts
import type { ChangeBusEvent, ChangeBusEventDataMap, SyncAdapter } from "@ez-kits/sync-client-core";

export function createMemorySyncAdapter<C extends ChangeBusEventDataMap>() {
  const listeners = new Set<(changes: ChangeBusEvent<C>[]) => void>();
  const pushed: ChangeBusEvent<C>[] = [];
  const adapter: SyncAdapter<C> & {
    pushed: ChangeBusEvent<C>[];
    emit(changes: ChangeBusEvent<C>[]): void;
  } = {
    pushed,
    /** Deliver remote changes to every running pull. */
    emit(changes) {
      for (const listener of listeners) listener(changes);
    },
    pull({ commitChanges }) {
      const listener = (changes: ChangeBusEvent<C>[]) => commitChanges({ changes, checkpoint: {} });
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async push({ events, commitChanges }) {
      pushed.push(...events);
      await commitChanges({ events });
    },
  };
  return adapter;
}
```

```ts
type DataMap = ChangeBusEventDataMapFromCollectionConfigMap<[typeof todosCollection]>;
const syncAdapter = createMemorySyncAdapter<DataMap>();
const client = createSyncClient({ collections: [todosCollection], dbAdapter, syncAdapter });
client.startSync();

await client.collections.todos.insert({ id: "a", title: "A", completed: false, updatedAt: 1 });
// ...wait until syncAdapter.pushed has the event

syncAdapter.emit([
  {
    type: "create",
    collection: "todos",
    data: { id: "r", title: "Remote", completed: true, updatedAt: 2 },
  },
]);
// ...wait until getMany() returns both
```

Pushes and pulls are asynchronous: in tests, poll for the expected state (for example every 50 ms, up to a few seconds) instead of asserting right away.

## One adapter per collection

A collection can carry its own adapter (`defineDrizzleCollection({ ..., syncAdapter })`). It receives only that collection's events and checkpoint. The client-level `syncAdapter` never pushes that collection, and must not list it in its `collections`.

## Checklist

- [ ] `pull` starts from the given `checkpoint` and its cleanup stops every timer and listener.
- [ ] Pulled create/update `data` contains the primary key; deletes carry `id`.
- [ ] Changes with equal cursor values are not skipped.
- [ ] `push` resolves only after the backend saved the events, and awaits `commitChanges`.
- [ ] Pushing the same events twice is harmless.
- [ ] Permanent refusals throw `PushRejectedError`; everything else throws a normal error.
- [ ] Errors never include record data in their messages (they end up in logs and sync status).
- [ ] Round trip with two clients on two databases: a write in one appears in the other, including updates and deletes.

The Firestore adapter (`packages/sync-firebase/src/firestore/create-sync-adapter-from-resolved.ts`) is a complete real-world example, with batching and error classification.
