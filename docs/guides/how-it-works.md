# How EzSync works

This page gives you the mental model. You do not need it to get started, but it explains almost every "why does it do that?" question.

## The layers

```
application
   │  client.collections.*, liveQuery, startSync / stopSync
   ▼
sync client           (@ez-kits/sync-client-core)
   │  change bus · pull and push · tab channel
   ├──────────────►  sync adapter (Firestore, Realtime Database, your own)
   ▼
DB adapter            (Drizzle, TypeORM)
   │  CRUD for collections · the local-change store (outbox, checkpoints, ...)
   ▼
DB storage            (exec, transaction, dialect, role)
   │  leader election and forwarding across tabs
   ▼
DB engine             (sql.js, SQLite WASM, PGlite), opened only by the leader
```

Each layer only knows the contract of the layer below it. That is why you can mix and match: any DB adapter runs on any DB storage of the same dialect, and the sync adapter never touches the database.

## What happens when you write

When you call `client.collections.todos.insert(todo)`:

1. EzSync gives the write an **event id** and opens **one database transaction**.
2. In that transaction it writes the row, appends an **outbox event** ("create todo X"), and marks the record as **dirty** (it has unpushed changes).
3. The transaction commits. All three parts are saved together, or none is.
4. Live queries in **every tab** re-run.
5. If sync is running, the outbox is **pushed** to the backend. Only after the backend confirms is the event removed from the outbox.

Because the outbox is in the same database and the same transaction as the row, a crash or a closed tab never loses a write, and never pushes a write that was not saved locally.

## What happens when remote data arrives

The sync adapter **pulls** changes in batches. For each batch EzSync:

1. opens one transaction,
2. applies each change (insert or update by primary key, or delete),
3. saves the batch's **checkpoint** (a bookmark of how far the pull got) in the same transaction,
4. commits, then refreshes live queries in every tab.

If anything fails, nothing of the batch is kept, and the pull restarts from the last saved checkpoint. No change is skipped.

If a pulled change hits a record that is **dirty** (it has local writes not pushed yet), that is a **conflict**. By default the local writes win. You can change this with a [conflict resolver](conflict-resolution.md).

## Many tabs, one database

Most browser databases allow only one holder at a time. EzSync handles this with a **leader**:

- Each tab starts its own storage worker.
- The workers use a Web Lock to elect one **leader**. Only the leader opens the database engine.
- The other tabs are **followers**. Their queries and transactions are forwarded to the leader.
- **Only the leader syncs.** Calling `startSync()` in a follower asks the leader to sync.
- When the leader tab closes, another tab takes over, reopens the saved database and continues.

This is invisible to your code: every tab can read, write and run live queries. You can see which role a tab has with `client.role` and `client.subscribeRole()`.

## Where state lives

Everything that matters is stored in the local database next to your rows, in tables EzSync creates and upgrades itself:

| Table                           | What it holds                                                      |
| ------------------------------- | ------------------------------------------------------------------ |
| `ez_sync_events`                | The **outbox**: local writes not yet confirmed by the backend      |
| `ez_sync_dirty_records`         | Which records have unpushed local writes                           |
| `ez_sync_applied_events`        | Event ids already applied, so a retried write is not applied twice |
| `ez_sync_checkpoints`           | The pull checkpoint of each collection                             |
| `ez_sync_skipped_remote_events` | Remote changes held back because of a conflict                     |
| `ez_sync_meta`                  | The schema version of these tables                                 |

Do not write to these tables. Deleting the whole database (for example on sign-out) is safe: the next pull simply starts from scratch.

## The guarantees

- **No lost writes.** A write leaves the outbox only when the backend accepted it, or when your app discards it on purpose.
- **Order is kept.** Writes are pushed in the order they were committed, across all tabs.
- **No skipped pulls.** A pulled batch and its checkpoint are saved together.
- **Refused writes do not block sync.** A write the backend refuses is set aside and retried later; everything else keeps syncing. See [Rejected writes](rejected-writes.md).
- **Your choice on conflicts.** A conflict is decided by your resolver, and the outbox is updated to match the decision.

## The trade-offs

- Pushes run **one at a time**, so the order is kept.
- A slow transaction blocks the database for **every tab** until it ends (it is rolled back after 10 seconds of inactivity by default).
- A push can be **sent twice** (for example after a network error once the server already saved it). Backends must accept the same write twice. The Firebase adapters do.

For the full reasoning behind each decision, see the [architecture decisions](../../architecture.md).
