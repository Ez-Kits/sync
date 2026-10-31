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

Do not configure the same collection in both. A client-level adapter pushes the outbox of **every** collection.

> **Local-only collections.** Every write goes into the outbox, and leaves it only when a sync adapter confirms it. If a collection is never synced, its outbox entries stay in the database. That is harmless for small amounts of data, but keep truly local data (UI state, drafts you never sync) out of collections.

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
- It is saved as a string. By default EzSync uses `JSON.stringify` / `JSON.parse`. If your checkpoint holds values that are not plain JSON, such as a Firestore `Timestamp` or a `Date`, provide your own serializer:

  ```ts
  createSyncClient({
    // ...
    checkpoint: {
      serialize: (checkpoint) =>
        JSON.stringify({ ...checkpoint, updatedAt: checkpoint.updatedAt.toMillis() }),
      deserialize: (value) => {
        const parsed = JSON.parse(value);
        return { ...parsed, updatedAt: Timestamp.fromMillis(parsed.updatedAt) };
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
  client.stopSync();
  // Optionally wipe local data: dispose the client, then delete the database.
});
```

For per-user data, consider one storage `key` and database name per user, so users never see each other's local data.

## Next

- [Sync with Cloud Firestore](firestore.md)
- [Conflict resolution](conflict-resolution.md)
- [Rejected writes](rejected-writes.md)
