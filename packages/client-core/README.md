# @ez-kits/sync-client-core

Provider-neutral client sync primitives for local-first applications. Core defines the collection, database, checkpoint, and outbox contracts; provider integrations implement `SyncAdapter` without adding provider dependencies to this package.

## Client lifecycle

Create a client with collections, a DB adapter, checkpoint storage, and an optional provider sync adapter. Call `startSync()` after app initialization and `stopSync()` when the client is no longer active. Network events pause and resume browser sync automatically. Subscribe to status with `subscribeStatus()` or pass `onSyncStatus` to receive `starting`, `syncing`, `idle`, `offline`, `stopped`, and `error` updates.

Implement a `SyncAdapter` with provider `pull` and `push` methods. `pull` and `push` may return promises; push should resolve only after the provider has durably accepted the supplied events and invoke `commitChanges` only after success. `commitChanges` returns a promise that settles once the acknowledged events have left the outbox; await it before `push` resolves. Core serializes push batches, starts the next one only after every acknowledgement of the previous one has finished (awaited by the adapter or not), and retries failures, including a failed acknowledgement, with bounded exponential delays through `onSyncError`. Failed events are not acknowledged and remain in the outbox for a later sync start or subsequent push.

## Storage layers

```
sync client ──> DB adapter (ORM bridge) ──> DBStorage (contract) ──> engine (the real database)
```

- A **`DBStorage`** wraps one database engine: `exec(query)`, `transaction(fn)`, its `dialect` (`sqlite` or `postgres`), and its `role`. Engine packages implement it: `@ez-kits/sync-storage-sqljs`, `@ez-kits/sync-storage-sqlite-wasm`, and `@ez-kits/sync-storage-pglite`.
- A **DB adapter** turns the storage into a driver for its ORM (for example `createDrizzleSqliteDBAdapter({ dbStorage, collections })` from `@ez-kits/sync-client-drizzle-adapter/sqlite`). It implements collection CRUD, keeps the outbox (`localChangeStore`) in the same database, and runs its transactions on `dbStorage.transaction`.
- The **sync client** takes the adapter: `createSyncClient({ collections, dbAdapter, checkpointStorage })`.

`createLocalDBStorage({ dialect, open })` runs an engine in this context, which always leads. Use it for Node, tests, single-context apps, and engines that are already shared across tabs.

## Persistence guarantees

Every local collection mutation is crash-safe: the collection row, outbox event, and dirty-record state commit together or none are persisted. The adapter's required `commitLocalMutation` runs the row mutation and both local-change writes in one storage transaction. It passes the transaction handle to the store write methods, and the change bus is notified only after commit. Adapters without a DB storage or an atomic local-change store are rejected; there is no default outbox or best-effort mutation path.

The local-change store owns its schema. Every store implements `initialize()`, which creates the outbox and dirty-record storage when it is missing, upgrades storage an older version created, and must be idempotent and safe to run from several tabs at once. The sync client calls it once the DB storage is ready, in every context, and waits for it before any collection read or write, live query, or sync. A failure rejects those operations and reports a sync `error` status. Applications never create these tables in their own migrations.

Adapters should implement `getOptional` to distinguish an absent record from a database failure. When it is unavailable, core treats an explicit `undefined` from `get` as absence and propagates rejected reads; it never infers absence from an arbitrary database error. `get` remains available when callers require the row to exist.

## Conflicts and browser tabs

Pass `resolveConflict` to inspect an incoming remote event when the same record has a locally pending write. Return `"remote"`, `"local"`, or `{ data }`. The resolver runs inside the transaction that applies the pulled changes and receives the local row as `local`; it must not query the database itself, because that query would wait for the transaction it runs in. The decision is reconciled with the outbox in that transaction:

- `"local"` skips the remote event; the pending local writes are pushed later and win on the remote.
- `"remote"` applies the remote event and discards the record's pending local writes, so they are never pushed over it.
- `{ data }` stores `data` locally and replaces the record's pending writes with one outbox event that pushes it, scheduled once the pull commits. After a remote delete, `data` recreates the record.

With no hook, a record with pending local writes keeps its local state (the `"local"` decision); records without pending writes always take remote changes. Live queries, other tabs and `onRemoteChangesCommitted` see the changes as applied, not the raw remote events. A push already in flight when a decision replaces its events cannot be recalled: the provider applies it after the decision, and both sides converge on it once pull delivers it back. Applications should include comparable version metadata if they need a stronger deterministic winner policy.

## Multiple tabs

`createWorkerDBStorage({ dialect, key, worker, engineOptions })` (wrapped by each engine package) gives every tab its own dedicated worker. The worker module calls `startDBStorageWorker(open)`.

- **Election happens in the workers.** They compete for one Web Lock (`ez-sync:db:<key>:leader`). The leader's worker calls `open` and holds the real database. The other workers forward every statement and transaction to it over `BroadcastChannel`. Only the leader opens the engine, so engines that allow a single holder (sql.js snapshots, the OPFS SAH pool) never clobber each other.
- **Transactions are forwarded.** A follower runs its adapter transaction itself. Each statement carries the transaction id, and the leader serves no other context until that transaction commits or rolls back. The leader rolls the transaction back when the follower's context dies (detected through a per-context Web Lock) or stays idle longer than `transactionTimeoutMs`. A statement sent outside a transaction never joins it, even from the context that owns it: it waits for the commit or rollback, so it neither sees uncommitted rows nor is rolled back with them. Work inside a transaction must go through its handle: `dbAdapter.transaction(fn)` passes `fn` the transaction's operations and a context whose `native` handle the local-change store methods accept as `transactionContext`. Never send `BEGIN`/`COMMIT` yourself (`TransactionStatementError`); use the adapter's `transaction`.
- **Handover.** When the leader closes, crashes, or its page enters the back/forward cache, the next worker reopens the persisted database. Reads in flight are re-sent to it. Writes and transactions in flight fail with the retriable `LeaderChangedError`, because the old leader may or may not have applied them. The sync client retries local mutations, and skips the retry when the first attempt already reached the database: `appendEvents` records each event `id` as applied in the mutation's transaction, the record outlives the event's acknowledgement, and `hasAppliedEvent` answers for it, so a retry never re-applies a write that a newer one may have replaced. Stores prune these records once they are `APPLIED_EVENT_RETENTION_MS` (24 hours) older than the newest appended event. Requests fail with `LeaderUnavailableError` only when no leader answers. Without Web Locks or `BroadcastChannel`, `ready` rejects with `CoordinationUnavailableError`.
- **Sync follows the storage.** Only the tab whose worker leads runs sync. A follower's `startSync()` asks the leader to sync. Writes and pulled changes are announced once, by the context that committed them, so live queries in every tab refresh and the leader pushes followers' outbox events. Going offline or calling `stopSync()` pauses sync but keeps leadership; `dispose()` releases it.

`client.role` and `subscribeRole()` report whether this tab leads (`"leader"` or `"follower"`). Client-side coordination is not a substitute for server-side conflict detection.

Outbox stores return pending events in commit order: the database assigns each event an increasing position (`seq`) when it is appended, and transactions run one at a time on the leader, so the order holds across tabs and within one millisecond. Acknowledging pushed events (deleting them and refreshing dirty records) runs in one transaction.

Provider `pull` implementations should pass listener failures to the optional `onError` callback. Core reports the failure and retries the pull stream with capped backoff; stopping sync cancels the retry. Checkpoints remain tied to successfully committed local changes. A batch whose local commit fails (a transaction timeout, a leader change, a database error or a throwing resolver) fails its stream the same way: core calls the stream's cleanup, drops every batch that stream delivers afterwards, including ones already queued, and resubscribes from the last saved checkpoint, so the provider sends the failed changes again. Cleanup must therefore stop the listener, and each `pull` call must start from the checkpoint it is given rather than from a cursor kept by an earlier subscription.

## Provider adapter responsibilities

- Map stable collection and record IDs in both directions.
- Make repeated pushes idempotent; only acknowledge events after successful remote writes.
- Define tombstone and physical-removal behavior.
- Persist checkpoints only after applying the corresponding local changes.
- Ensure checkpoint queries handle equal cursor values and updates to existing records; provider-specific query semantics belong in the provider package.

## Development

```bash
pnpm --filter @ez-kits/sync-client-core build
pnpm --filter @ez-kits/sync-client-core test
```
