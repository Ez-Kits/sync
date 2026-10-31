# EzSync architecture decisions

This file records the architecture decisions behind EzSync: what was decided, why, and what it costs. It explains why the API has the shape it has, not how to use it. Add a new entry when a decision changes, and mark the old one as superseded instead of rewriting it.

Each entry has a status (`Accepted`, `Superseded by ADR-n`), the date of the commit that introduced it, the context, the decision and its consequences.

## Overview

```
application
   │  collections, liveQuery, startSync / stopSync
   ▼
sync client (@ez-kits/sync-client-core)
   │  change bus · sync handlers (pull / push) · tab channel
   ├──────────────► SyncAdapter (provider: @ez-kits/sync-firebase, ...)
   ▼
DB adapter (ORM bridge: Drizzle, TypeORM)
   │  collection CRUD · local-change store (outbox, dirty records, checkpoints, skipped remote events)
   ▼
DBStorage (contract: exec, transaction, dialect, role)
   │  leader election and forwarding across tabs
   ▼
DB engine (sql.js, SQLite WASM, PGlite), opened only by the leader
```

| ADR | Decision                                                                      |
| --- | ----------------------------------------------------------------------------- |
| 1   | Provider- and ORM-neutral core; integrations in separate packages             |
| 2   | Layered storage: DB adapter → `DBStorage` → engine                            |
| 3   | Every local mutation is atomic with its outbox writes                         |
| 4   | The local-change store owns its schema                                        |
| 5   | Outbox order comes from a database-assigned sequence                          |
| 6   | One leader per database, elected in workers; others forward to it             |
| 7   | Sync runs only in the leader context                                          |
| 8   | Retried mutations are recognised by a durable record of their event id        |
| 9   | Pushes are serialized and acknowledged only after durable acceptance          |
| 10  | Rejected writes are narrowed down and parked, never dropped                   |
| 11  | Pulled batches commit with their checkpoint, or are pulled again              |
| 12  | Conflicts are resolved in the pull transaction and reconciled with the outbox |
| 13  | Sync state lives in the database with the rows it describes                   |
| 14  | Checkpoint storage is internal; only serialization is configurable            |
| 15  | Conflict policies ship as a separate, provider-neutral package                |
| 16  | Firebase adapter classifies errors and acknowledges as it progresses          |
| 17  | TypeORM adapter transactions run on their own data source on SQLite           |
| 18  | Reads distinguish an absent record from a failed query                        |
| 19  | Browser engines: sql.js snapshots, SQLite WASM on OPFS SAH pool, PGlite       |

---

## ADR-1: Provider- and ORM-neutral core

- **Status:** Accepted
- **Date:** 2026-10-24 (`SyncAdapter` API, 539c413)

**Context.** Applications pick their local database, ORM and backend independently. A core that imports Firebase or an ORM would force those dependencies on every user and couple sync logic to one provider's semantics.

**Decision.** `@ez-kits/sync-client-core` defines contracts only: collections, `BaseDBAdapter`, `ILocalChangeStore`, `DBStorage`, `SyncAdapter`, conflict resolution, and the runtime that drives them. ORM bridges (`sync-client-drizzle-adapter`, `sync-client-typeorm-adapter`), storage engines (`sync-storage-*`), providers (`sync-firebase`), framework bindings (`sync-client-react`) and conflict policies (`sync-conflict-resolution`) live in their own packages. Packages that support several dialects or providers expose one entry point each (`/sqlite`, `/pg`, `/sync-firestore`, `/sync-realtime-db`), so an app bundles only what it uses.

**Consequences.**

- A new backend or ORM is a new package implementing a core contract; core does not change.
- Provider-specific behaviour (checkpoint queries, tombstones, error codes) must be documented and tested in the provider package, not assumed by core.
- The contracts are the product: changing one is a breaking change across several packages.

## ADR-2: Layered storage behind a `DBStorage` contract

- **Status:** Accepted
- **Date:** 2026-10-28 (fc54085)

**Context.** Browser databases differ in how they persist (in-memory with IndexedDB snapshots, OPFS, IndexedDB data dir) and most allow a single holder. ORMs expect a driver. Mixing engine, coordination and ORM code makes every combination a special case.

**Decision.** Split storage into three layers:

- **Engine** (`DBEngine`): the real database, `exec`, optional `flush`, `close`. Opened only by the leader.
- **`DBStorage`**: one structured-cloneable statement interface (`exec`, `transaction`) with `dialect` (`sqlite` | `postgres`), `role`, readiness and invalidation events. It hides where the engine runs.
- **DB adapter**: turns a `DBStorage` into an ORM driver (Drizzle proxy drivers, a TypeORM driver), implements collection CRUD and the local-change store in the same database.

`createLocalDBStorage` runs an engine in the current context (Node, tests, single-context apps); `createWorkerDBStorage` runs it in a coordinated worker (ADR-6).

**Consequences.**

- Any adapter works with any engine of its dialect; adapters reject a storage of another dialect.
- ORMs must not manage transactions themselves: a bare `BEGIN`/`COMMIT` is rejected (`TransactionStatementError`). Drizzle users must not call `queryBuilder.transaction()`; TypeORM's transaction statements are mapped onto `dbStorage.transaction`.
- Statements sent outside an open transaction wait for it to end, so awaiting one inside the transaction deadlocks until the transaction timeout. Work inside a transaction goes through its handle.

## ADR-3: Every local mutation is atomic with its outbox writes

- **Status:** Accepted
- **Date:** 2026-10-25 (cb9a3d6)

**Context.** A local-first write has three parts: the row, the outbox event that will push it, and the dirty-record state that protects it from being overwritten by a pull. If any part can persist without the others, a crash loses a write or pushes one that never happened locally.

**Decision.** `commitLocalMutation` is required on every adapter and runs the row mutation, the outbox append and the dirty-record update in one storage transaction. The change bus is notified only after commit. The sync client refuses adapters without a `DBStorage` or an `AtomicLocalChangeStore` (`atomicLocalMutationCapability: "atomic"`); there is no default outbox and no best-effort path.

**Consequences.**

- The outbox must live in the same database as the rows, which rules out keeping it in localStorage or a separate store.
- Adapter authors carry more responsibility, but core never has to repair a half-written mutation.

## ADR-4: The local-change store owns its schema

- **Status:** Accepted
- **Date:** 2026-10-29 (50443fe; extended by b322bb8)

**Context.** The outbox tables are library internals that change between versions. Asking applications to create and migrate them invites drift and broken upgrades.

**Decision.** Every store implements `initialize()`, which creates missing tables, upgrades tables an older version created, and records the schema version in `ez_sync_meta`. It must be idempotent and safe to run from several tabs at once. The sync client calls it once the storage is ready, in every context, and blocks every read, write, live query and sync on it. Tables: `ez_sync_events`, `ez_sync_dirty_records`, `ez_sync_applied_events` (schema v3), `ez_sync_checkpoints` and `ez_sync_skipped_remote_events` (schema v4).

**Consequences.**

- Applications migrate only their own tables.
- Every schema change needs an in-place upgrade step from each earlier version, run in one transaction, and a schema-version bump.
- A failed `initialize()` fails every operation and reports a sync `error` status rather than running against a partial schema.

## ADR-5: Outbox order comes from a database-assigned sequence

- **Status:** Accepted
- **Date:** 2026-10-29 (50443fe)

**Context.** Ordering pending events by `createdAt` breaks across tabs (clock skew) and within one millisecond.

**Decision.** Each appended event gets an increasing `seq` from the database (`INTEGER PRIMARY KEY AUTOINCREMENT` on SQLite, a `BIGINT` identity on Postgres). Pending events are read in `seq` order. Since transactions run one at a time on the leader, `seq` is commit order across all tabs. Tables from older versions are rebuilt, numbering pending events in their old `createdAt, id` order.

**Consequences.** Custom outbox tables must provide a `seq` column. Event `id`s stay unique and remain the identity used for acknowledgement.

## ADR-6: One leader per database, elected in workers; others forward to it

- **Status:** Accepted
- **Date:** 2026-10-27 to 2026-10-28 (9741894, fc54085)

**Context.** sql.js snapshots and the OPFS SAH pool allow only one holder; two tabs opening them clobber each other. Every tab still needs to read and write.

**Decision.** Each tab starts a dedicated worker that calls `startDBStorageWorker(open)`. Workers compete for the Web Lock `ez-sync:db:<key>:leader`. The leader opens the engine; followers forward statements and transactions over `BroadcastChannel`.

- **Transactions are forwarded.** A follower runs its transaction itself; each statement carries the transaction id, and the leader serves no other context until it commits or rolls back. The leader rolls it back when the owning context dies (per-context Web Lock) or stays idle past `transactionTimeoutMs`.
- **Handover.** When the leader closes, crashes or enters the back/forward cache, the next worker reopens the persisted database. In-flight reads are re-sent; in-flight writes and transactions fail with the retriable `LeaderChangedError`, because the old leader may or may not have applied them.
- Without Web Locks or `BroadcastChannel`, `ready` rejects with `CoordinationUnavailableError` instead of running uncoordinated.

**Consequences.**

- Engines need no multi-tab support of their own.
- Every write may fail with `LeaderChangedError` and callers must handle an ambiguous outcome (ADR-8).
- A slow or hung transaction blocks every tab until it times out.
- Client-side coordination is not a substitute for server-side conflict detection.

## ADR-7: Sync runs only in the leader context

- **Status:** Accepted
- **Date:** 2026-10-28 (fc54085)

**Context.** If every tab pulled and pushed, the same events would be pushed several times and pulled batches would race.

**Decision.** Only the tab whose worker leads runs sync. A follower's `startSync()` sends a sync request to the leader. Committed changes are announced once over a `SyncTabChannel` by the context that committed them, so live queries in every tab refresh and the leader pushes followers' outbox events. A leader change triggers `onInvalidate`: notifications may have been missed, so contexts re-read everything. `stopSync()` and going offline pause sync but keep leadership; `dispose()` releases it.

**Consequences.** State held in the leader's memory (parked rejections, ADR-10) is lost on handover; anything that must survive a handover lives in the database (ADR-13).

## ADR-8: Retried mutations are recognised by a durable record of their event id

- **Status:** Accepted
- **Date:** 2026-10-29 (0eac801)

**Context.** After a `LeaderChangedError`, the sync client retries the mutation (up to 3 attempts). If the first attempt did commit, replaying it can overwrite a newer write. Checking the outbox is not enough: the event may already have been pushed and acknowledged.

**Decision.** `appendEvents` records each event `id` in `ez_sync_applied_events` in the mutation's transaction. The record outlives acknowledgement, and `hasAppliedEvent` answers whether the attempt landed. Records are pruned once they are `APPLIED_EVENT_RETENTION_MS` (24 hours) older than the newest appended event.

**Consequences.** One extra row per mutation, bounded by the retention window, which is far longer than any retry takes.

## ADR-9: Pushes are serialized and acknowledged only after durable acceptance

- **Status:** Accepted
- **Date:** 2026-10-25 to 2026-10-29 (ea4582a, 50443fe)

**Context.** Concurrent pushes can re-read events another push is about to acknowledge, and acknowledging before the provider has accepted a write loses it on failure.

**Decision.** A `SyncAdapter.push` resolves only after the provider durably accepted the events, and calls `commitChanges` only for accepted events. `commitChanges` deletes them from the outbox and refreshes dirty records in one transaction, and returns a promise the adapter awaits. Core runs one push at a time and starts the next only after every acknowledgement of the previous one settled. Failures, including a failed acknowledgement, are retried with bounded exponential backoff, re-sending whatever is still in the outbox.

**Consequences.** Providers must make repeated pushes idempotent (stable ids, idempotent writes), since a push can be re-sent after a partial success. Throughput is bounded by one push in flight; providers can acknowledge progressively within one push (ADR-16).

## ADR-10: Rejected writes are narrowed down and parked, never dropped

- **Status:** Accepted
- **Date:** 2026-10-29 (19fa9fe, 03e8ac8)

**Context.** A write refused by security rules or validation fails on every retry. With serialized pushes (ADR-9) it would block every later write. Dropping it silently loses user data; a signed-out client would lose everything.

**Decision.**

- Adapters mark refusals that resending would meet again as permanent (`PushRejectedError` or `permanent: true`). Network, quota and authentication errors stay retriable.
- On a permanent failure core re-pushes the outbox in halves, in order, until each refused event is pushed alone. Accepted events are acknowledged. An event refused alone is **parked**: it stays in the outbox, and it and later events of the same record are held back so per-record order holds, while other records keep syncing.
- Parked events are retried after a backoff (5 s doubling to 60 s), on every sync start and on `client.retryRejectedPushes()`. A retry begins with a single **probe** event; if it is refused again the retry stops, so a client whose every write is refused costs one provider write per retry. The probe rotates through parked records so one unwritable event cannot block the others indefinitely.
- `onPushRejected` reports each parked event once. Only `discard()` removes one, transactionally, as if acknowledged.
- Parking lives in the leader's memory.

**Consequences.**

- Nothing leaves the outbox unless acknowledged or explicitly discarded.
- A "poison" event delays other parked records' retries whenever it is the probe, bounded by rotation; the application should `discard()` it and revert the local row.
- After a reload or leader change parked events are simply pushed again, which is safe because nothing was written for them.

## ADR-11: Pulled batches commit with their checkpoint, or are pulled again

- **Status:** Accepted
- **Date:** 2026-10-25 to 2026-10-29 (ea4582a, 2bde176)

**Context.** If a checkpoint advances past a batch whose local commit failed, those changes are never pulled again.

**Decision.** A pulled batch and its checkpoint commit in one transaction. If the commit fails (transaction timeout, leader change, database error, throwing resolver), core calls the stream's cleanup, drops every later batch of that stream including queued ones, and resubscribes from the last saved checkpoint. Listener failures reported through `onError` are retried with capped backoff; stopping sync cancels the retry.

**Consequences.** Provider `pull` must start from the checkpoint it is given, not from a cursor kept by an earlier subscription, and its cleanup must stop every listener. Checkpoint queries must handle equal cursor values and updates to existing records.

## ADR-12: Conflicts are resolved in the pull transaction and reconciled with the outbox

- **Status:** Accepted
- **Date:** 2026-10-29 (2bde176, 19fa9fe)

**Context.** A remote change can arrive for a record with pending local writes. Choosing a side in the row alone leaves the outbox inconsistent: a `"remote"` choice would still push the stale local writes over it.

**Decision.** `resolveConflict` runs inside the pull transaction with `remote` and `local` and returns:

- `"local"` (the default with no resolver): skip the remote event; pending writes are pushed later and win.
- `"remote"`: apply it and discard the record's pending writes.
- `{ data }`: store `data` and replace the record's pending writes with one event that pushes it.

Records without pending writes always take remote changes. A skipped remote event is kept (ADR-13) and applied by the acknowledgement that leaves the record clean, because pull and push are independent streams: the server's echo of a pushed write, with server-assigned fields, may arrive before the push is acknowledged.

**Consequences.**

- The resolver must not query the database; that would wait on the transaction it runs in.
- An async resolver holds the pull batch and its checkpoint until it settles.
- A push already in flight cannot be recalled by a later decision; both sides converge once the pull delivers it back. Applications needing a deterministic winner should carry comparable version metadata.

## ADR-13: Sync state lives in the database with the rows it describes

- **Status:** Accepted
- **Date:** 2026-10-29 (b322bb8)

**Context.** Checkpoints were kept in localStorage and skipped remote events in memory. A database that was reset (in-memory sql.js, cleared IndexedDB, deleted on logout, new storage key) kept a checkpoint for rows it no longer had, so the next pull skipped them. A skipped remote event was lost on reload or leader change.

**Decision.** Checkpoints (`ez_sync_checkpoints`) and the latest skipped remote event per record (`ez_sync_skipped_remote_events`) are stored by the local-change store. Each pulled checkpoint is saved in the transaction that commits its rows; skipped events are written in the pull transaction and applied and removed in the acknowledgement transaction.

**Consequences.**

- Losing the database loses its checkpoints too, so the next pull starts over. Correct, at the cost of a full re-pull.
- Upgrading from localStorage checkpoints triggers one full re-pull per collection, which the outbox and conflict handling make safe.
- This supersedes the earlier `checkpointStorage` option and `createLocalStorageCheckpointStorage`.

## ADR-14: Checkpoint storage is internal; only serialization is configurable

- **Status:** Accepted
- **Date:** 2026-10-29 (241c041)

**Context.** Once checkpoints must commit in the pull transaction (ADR-13), a pluggable checkpoint store can only break that guarantee.

**Decision.** `CheckpointStorage` is internal and not exported. The only option is `checkpoint: { serialize, deserialize }`, defaulting to JSON, for checkpoints with non-JSON values such as a Firestore `Timestamp`. `client.getCheckpoint` / `saveCheckpoint` read and replace a checkpoint outside any pull transaction; `saveCheckpoint(collection, undefined)` forces a full re-pull.

**Consequences.** Less configuration and no way to misplace checkpoints. Applications with exotic checkpoint types must write a serializer.

## ADR-15: Conflict policies ship as a separate, provider-neutral package

- **Status:** Accepted
- **Date:** 2026-10-25 (b0dcfae)

**Context.** Common policies (last write wins, field merge, delete vs update) are reusable but opinionated; core should only define the resolver contract.

**Decision.** `@ez-kits/sync-conflict-resolution` exports `localWins`, `remoteWins`, `lastWriteWins`, `mergeFields`, `deleteVsUpdate` and `manualResolution`, all plain `resolveConflict` functions. Edge cases (`onMissingVersion`, `onTie`) are required options so they are chosen deliberately.

**Consequences.** There is no durable deferred-conflict state in core; an application that defers decisions stores and replays them itself.

## ADR-16: Firebase adapter classifies errors and acknowledges as it progresses

- **Status:** Accepted
- **Date:** 2026-10-29 (4d374ce, 19fa9fe)

**Context.** Firebase limits batch sizes, reports refusals and transient failures through error codes, and needs deletes addressed to the same document as creates.

**Decision.**

- Firestore pushes commit in batches of up to 500 writes and acknowledge each before the next, so a failure leaves only its own and later events in the outbox. The Realtime Database adapter coalesces each record's events into one multipath `update`, splitting when paths would nest.
- `resolveDocumentId` / `resolveRecordId` address every event, deletes included.
- Permanent: Firestore `permission-denied`, `invalid-argument`, `out-of-range`, `failed-precondition`; RTDB `PERMISSION_DENIED` and synchronous SDK validation errors. Everything else, including `unauthenticated` and unknown codes, is retried rather than risk dropping a write.
- Deletes are tombstones by default (`deleted: true`, `deletedAt`) so listeners propagate them.

**Consequences.** A signed-out client's writes are parked, not lost; apps call `retryRejectedPushes()` on sign-in. Authentication and security rules remain the host application's responsibility.

## ADR-17: TypeORM adapter transactions run on their own data source on SQLite

- **Status:** Accepted
- **Date:** 2026-10-29 (606408d)

**Context.** TypeORM's SQLite drivers share one query runner per data source, so every statement sent while an adapter transaction was open joined it. Live queries, `get`/`getMany` and the commit check of a retried mutation saw uncommitted pull data, and application writes made during a sync transaction rolled back with it.

**Decision.** The adapter's own transactions (`transaction`, `commitLocalMutation`, applying pulled changes) run on a second data source over the same `DBStorage`. Statements on the application-facing `db` wait for them like any statement outside a transaction (ADR-2). `db.destroy()` closes the second data source too; the next adapter transaction reopens it. On `db` itself, statements sent while one of its own transactions is open still join it, as on one SQLite connection.

**Consequences.** Adapter transactions are isolated from application queries on every dialect, at the cost of a second data source per adapter.

## ADR-18: Reads distinguish an absent record from a failed query

- **Status:** Accepted
- **Date:** 2026-10-24 (539c413)

**Context.** Sync decisions such as conflict detection and whether a mutation already committed depend on whether a row exists. Treating any database error as "not found" would turn a failed read into a wrong write.

**Decision.** Adapters should implement `getOptional`, which returns `undefined` only when the row is absent and rejects on database errors. `get` rejects when the row is missing. When `getOptional` is not implemented, core treats an explicit `undefined` from `get` as absence and propagates rejections; it never infers absence from an error.

**Consequences.** Adapter authors must keep "missing" and "failed" apart in both methods.

## ADR-19: Browser engines: sql.js snapshots, SQLite WASM on OPFS SAH pool, PGlite

- **Status:** Accepted
- **Date:** 2026-10-28 (fc54085)

**Context.** Each browser engine persists differently and accepts one holder, and some persistence options require cross-origin isolation headers that many hosts cannot set.

**Decision.** Ship one engine per package, each opened only by the leader's worker (ADR-6) through `startDBStorageWorker(open)`:

- **`sync-storage-sqljs`**: sql.js in memory, snapshotted to IndexedDB after every commit and every write outside a transaction (`DBEngine.flush`). A new leader reopens the last snapshot. Statements without parameters may contain several statements, to keep migrations simple.
- **`sync-storage-sqlite-wasm`**: the official SQLite WASM build on the `opfs-sahpool` VFS, which needs no COOP/COEP headers. The pool allows one holder per origin, so the leader releases it when it steps down.
- **`sync-storage-pglite`**: PGlite (Postgres dialect) persisted to IndexedDB (`idb://...`).

The application's worker module opens the engine and may run its own table migrations there.

**Consequences.** sql.js rewrites the whole snapshot on each commit, which costs more as the database grows; SQLite WASM writes incrementally to OPFS. Choosing an engine is a per-application trade-off between bundle size, write cost and dialect.
