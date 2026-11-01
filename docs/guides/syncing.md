# Syncing

Sync has two directions:

- **Push**: send local writes from the outbox to the backend.
- **Pull**: bring remote changes into the local database.

Both are done by the **sync adapter** you pass to the client. This page covers what is the same for every backend. For the backend setup itself, see [Firestore](firestore.md), [Realtime Database](realtime-database.md) or [your own backend](../extending/custom-sync-adapter.md).

## Start and stop

```ts
const client = createSyncClient({ collections: [todosCollection], dbAdapter, syncAdapter });

client.startSync(); // start pulling and pushing
client.stopSync(); // pause; local reads and writes keep working
```

- Call `startSync()` once your app is ready, for example after the user signed in. Call it in **every tab**: only the leader really syncs, and a follower's call asks the leader to sync.
- Writes made **before** `startSync()` or while offline are not lost. They wait in the outbox and are pushed when sync runs.
- `stopSync()` pauses sync in this tab. It does not delete anything.
- `await client.dispose()` stops sync and closes the database for this tab for good. Use it on sign-out, or when a test ends.

### One adapter for all collections, or one per collection

The usual way is **one sync adapter for the whole client**:

```ts
createSyncClient({ collections: [todosCollection, projectsCollection], dbAdapter, syncAdapter });
```

You can instead give a single collection its own adapter in its definition:

```ts
defineDrizzleCollection({ name: "todos", table: todos, syncAdapter: todosSyncAdapter });
```

A collection with its own adapter is synced by that adapter only: the client-level adapter never pushes it. A client-level adapter that lists its collections (the Firebase adapters do, see below) must not list one that has its own adapter: `createSyncClient` throws if it does.

### Which collections a client-level adapter syncs

A sync adapter can declare the collections it syncs in a `collections` array. The Firebase adapters fill it in from the collection configs you pass them. The client-level adapter then gets the outbox events of those collections only. An adapter without `collections` gets the events of every collection that has no adapter of its own.

> **Local-only collections.** A write to a collection that no adapter syncs (it has no adapter of its own, and the client-level adapter does not list it, or there is none) never enters the outbox. The row is written and the change is published as usual, but nothing is queued for a push. Syncing such a collection later does not push the writes made before: only writes made while an adapter covers the collection are pushed.

## Sync status

Show the user whether sync is running with `subscribeStatus` (or `onSyncStatus` in the client options):

```ts
const stop = client.subscribeStatus(({ status, error }) => {
  badge.textContent = status;
  if (status === "error") console.error(error);
});
```

The listener is called right away with the current status, then on every change.

| Status     | Meaning                                                                         |
| ---------- | ------------------------------------------------------------------------------- |
| `stopped`  | Sync is not running (`startSync()` not called yet, or `stopSync()` was called). |
| `starting` | Sync is starting, or restarting after the network came back.                    |
| `syncing`  | This tab is the leader and sync is running.                                     |
| `idle`     | Sync is wanted, but another tab is the leader and syncs for this one.           |
| `offline`  | The browser is offline. Sync resumes by itself when the network returns.        |
| `error`    | Something failed. `error` holds the cause. Sync keeps retrying when it can.     |

Errors never contain your document data, so they are safe to log.

A sync `error` status is usually temporary (the network, an expired token): EzSync retries with backoff. An error that does not go away is often a database problem (for example a missing table) or a bad sync adapter configuration.

## First sync and pull state

`status` says whether sync runs, not how far the pull got. `subscribePullState` reports it per collection:

```ts
const stop = client.subscribePullState(({ sessions }) => {
  // { available: true, hasRemoteData: true, caughtUp: false,
  //   progress: { pulled: 120, total: 3000 }, lastPulledAt: 1767225600000 }
});
```

| Field           | Meaning                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `available`     | Local data is good enough to show: the collection was pulled before on this device, its preview committed, or it caught up.                         |
| `hasRemoteData` | Whether the backend has rows: answered by the preview or by catching up; `true` when the collection was pulled before. `undefined` until then.      |
| `caughtUp`      | The backend's current state is applied. `false` again whenever the pull restarts (back online, `startSync()`, a new leader tab) or stops.           |
| `progress`      | `pulled`: changes this pull committed so far. `total`: how many it delivers, when the adapter counts (`countInitialPull` of the Firebase adapters). |
| `lastPulledAt`  | When a pulled batch last committed, or the collection caught up, for "Synced · 2 min ago". Kept in memory only.                                     |

Every tab shows the leader's state. `getPullState()` returns it without subscribing.

### Don't gate the screen on `caughtUp`

On a new device the full pull can take a while. Show data as soon as there is some, and let it fill in:

```ts
client.startSync();
await client.waitForPulled({ collections: ["sessions"], until: "available", timeoutMs: 15_000 });
const { sessions } = client.getPullState();
router.go(sessions.hasRemoteData ? "/home" : "/onboarding");
```

1. `until: "available"` resolves after the preview (one small query, see [Firestore](firestore.md#show-rows-on-the-first-sync) or [Realtime Database](realtime-database.md#show-rows-on-the-first-sync)), or at once on a device that synced before.
2. `hasRemoteData` tells a returning user from a new one without downloading everything.
3. Live queries show the preview rows, then fill in as the full pull commits: large batches commit in chunks of 200 rows, so the page and local writes are never held up for the whole download.
4. While `!caughtUp`, show a small "Downloading 120 of 3,000…" from `progress`.

Wait for `caughtUp` (the default of `waitForPulled`) only for flows that read everything and then change it, such as replacing an account's data. `waitForPulled` rejects with a `WaitForPulledError` (`reason`: `"timeout"`, `"stopped"` or `"disposed"`) after `timeoutMs`, when `stopSync()` is called meanwhile, or on `dispose()`. Offline, `caughtUp` stays `false`, so pass a timeout.

## Pending writes

`status` says whether sync runs, not whether everything was pushed. For that, count the outbox: the local writes the backend has not confirmed yet.

```ts
const stop = client.subscribePendingWrites(({ total, rejected }) => {
  line.textContent = total ? `${total} changes waiting` : "Synced";
  if (rejected) warning.textContent = `${rejected} changes were refused`;
});

const { total, rejected, byCollection } = await client.getPendingWrites(); // one-off read
```

The listener is called once the outbox was read, then after every local write (in any tab), every confirmed push, and every parked or discarded write. It works before `startSync()` and while offline, and every tab sees the same counts.

| Field          | Meaning                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `total`        | Outbox events not yet confirmed by the backend, parked ones included. Two writes to a row count 2. |
| `rejected`     | Of those, the writes parked after a refusal (see [Rejected writes](rejected-writes.md)).           |
| `byCollection` | `total` per collection name; collections with nothing pending are left out.                        |

`rejected` is known to the leading tab once it tried to push: after a reload, parked writes count as plain pending until their first retry is refused again.

### Wait until everything is pushed

`waitForPushed()` resolves once the outbox holds nothing but parked writes, e.g. before deleting a database you copied from:

```ts
await client.waitForPushed({ timeoutMs: 15_000 });
```

It ignores parked writes, since they may never be accepted; check `rejected` yourself. It rejects with a `WaitForPushedError` (`reason`: `"offline"`, `"timeout"` or `"disposed"`, and `pending`, the last counts) when writes are pending while offline, after `timeoutMs`, or when the client is disposed. Writes are only pushed while sync runs in the leading tab, so call `startSync()` first, and pass a timeout.

## Online and offline

EzSync listens to the browser's `online` and `offline` events while sync is wanted:

- **Going offline** pauses sync (status `offline`). Local reads and writes keep working.
- **Coming back online** restarts sync. The outbox is pushed, and pulls resume from their checkpoints.

You do not need to do anything for this.

## Many tabs

All tabs of your app that use the same storage `key` share one database. One tab is the **leader**; it opens the database and is the only one that syncs.

```ts
client.role; // "leader" or "follower"
client.subscribeRole((role) => console.log("this tab is now the", role));
```

- Writes from followers are pushed by the leader.
- Remote changes pulled by the leader refresh live queries in every tab.
- When the leader tab closes, another tab becomes leader and continues syncing (if it called `startSync()`).

You rarely need the role, except to explain in your UI why a tab says "synced by another tab" (`idle`).

## Retrying failed pushes

Pushes that fail because of the network or a server error are retried automatically with a growing delay. Writes the backend **refuses** (security rules, validation) are handled differently: they are parked and retried less often, without blocking other writes. See [Rejected writes](rejected-writes.md).

## Pull checkpoints

A **checkpoint** is a bookmark that tells the sync adapter where the last pull stopped, so the next pull only fetches newer changes. EzSync stores it in the local database, in the same transaction as the pulled rows.

- What a checkpoint contains is up to the sync adapter (for example `{ updatedAt, id }` of the last document).
- Its type comes from the sync adapter, so `getCheckpoint` and `saveCheckpoint` are typed without annotations.
- It is saved as a string, with `JSON.stringify` / `JSON.parse` unless the sync adapter that syncs the collection has a `checkpointSerializer` (the Firestore and Realtime Database adapters take one as an option). A Firestore checkpoint holding a `Timestamp` needs one, see [Firestore](firestore.md). To store checkpoints differently, for example one holding a `Date`, pass your own; it replaces the adapter's for every collection:

  ```ts
  createSyncClient({
    // ...
    checkpointSerializer: {
      serialize: (checkpoint) => JSON.stringify({ ...checkpoint, at: checkpoint.at.getTime() }),
      deserialize: (value) => {
        const parsed = JSON.parse(value);
        return { ...parsed, at: new Date(parsed.at) };
      },
    },
  });
  ```

- Read or reset it yourself:

  ```ts
  const checkpoint = await client.getCheckpoint("todos");
  await client.saveCheckpoint("todos", undefined); // the next pull of "todos" starts from scratch
  ```

  A new checkpoint is used the next time the collection's pull starts (for example after `stopSync()` and `startSync()`).

If the local database is deleted, its checkpoints go with it, and the next pull fetches everything again. That is the correct, safe behaviour.

## Sign-in and sign-out

EzSync does not manage authentication. A typical flow:

```ts
onSignIn(() => {
  client.startSync();
  client.retryRejectedPushes(); // push writes refused while signed out
});

onSignOut(async () => {
  // Wiping local data loses writes that were not pushed yet: check first.
  const { total } = await client.getPendingWrites();
  if (total > 0) {
    try {
      await client.waitForPushed({ timeoutMs: 15_000 });
    } catch {
      return warn(`${total} changes haven't synced yet. Connect to the internet first.`);
    }
    // Parked (refused) writes are still in the outbox: decide whether to drop them.
  }
  client.stopSync();
  // Optionally wipe local data: dispose the client, then delete the database.
});
```

For per-user data, consider one storage `key` and database name per user, so users never see each other's local data.

## Next

- [Sync with Cloud Firestore](firestore.md)
- [Conflict resolution](conflict-resolution.md)
- [Rejected writes](rejected-writes.md)
