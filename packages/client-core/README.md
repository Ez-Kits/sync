# @ez-kits/sync-client-core

Provider-neutral client sync primitives for local-first applications. Core defines the collection, database, checkpoint, and outbox contracts; provider integrations implement `SyncAdapter` without adding provider dependencies to this package.

## Client lifecycle

Create a client with collections, a database adapter, checkpoint storage, and an optional provider sync adapter. Call `startSync()` after app initialization and `stopSync()` when the client is no longer active. Network events pause and resume browser sync automatically. Subscribe to status with `subscribeStatus()` or pass `onSyncStatus` to receive `starting`, `syncing`, `idle`, `offline`, `stopped`, and `error` updates.

Implement a `SyncAdapter` with provider `pull` and `push` methods. `pull` and `push` may return promises; push should resolve only after the provider has durably accepted the supplied events and invoke `commitChanges` only after success. Core serializes push batches and retries failures with bounded exponential delays. Failed events are not acknowledged and remain in the outbox for a later sync start or subsequent push.

## Persistence guarantees

Every local collection mutation is crash-safe: the collection row, outbox event, and dirty-record state commit together or none are persisted. A `SyncClient` therefore requires storage built by `createCoordinatedStorage` (or an adapter helper such as `createDrizzleStorage`), which builds the database adapter and outbox store from one database handle. Plain objects are rejected at runtime and at the type level.

```ts
const storage = createCoordinatedStorage({
  coordinationKey: "todos",
  open: async () => {
    const engine = await startEngine(); // runs only in the context that owns the database
    return {
      database: engine.db,
      execute: (request) => engine.run(request),
      close: () => engine.stop(),
    };
  },
  connect: (send) => createRemoteDatabase(send), // other tabs: forward I/O to the owner
  createDBAdapter: (db) => createDatabaseAdapter(db),
  createLocalChangeStore: (db) => createOutboxStore(db),
});

const client = createSyncClient({ collections, storage, checkpointStorage });
```

The database adapter's required `commitLocalMutation` method must run the row mutation and both local-change writes in the same durable transaction. It passes its native transaction context to the store write methods, and the change bus is notified only after commit. Unsupported or incompatible storage rejects; there is no default outbox or best-effort mutation path. Core exports the local-change-store types only; database integrations provide the storage implementation.

Adapters should implement `getOptional` to distinguish an absent record from a database failure. When it is unavailable, core treats an explicit `undefined` from `get` as absence and propagates rejected reads; it never infers absence from an arbitrary database error. `get` remains available when callers require the row to exist.

## Conflicts and browser tabs

Pass `resolveConflict` to inspect an incoming remote event when the same record has a locally pending write. Return `"remote"`, `"local"`, or `{ data }`. With no hook, remote changes are applied in arrival order. Applications should include comparable version metadata if they need a stronger deterministic winner policy.

## Multiple tabs

Storage, not only sync, is coordinated across tabs. One Web Lock (`ez-sync:<coordinationKey>`) elects the storage owner, and the owner is the only context that syncs. Going offline or calling `stopSync()` pauses sync but keeps ownership; `dispose()` releases it.

- `sharing: "exclusive"` (default) is for databases that live in one context at a time: in-memory, WASM, or per-tab workers. Only the owner calls `open`. Other tabs build their adapter from `connect(send)`, so `liveQuery` keeps its typed query builder, but every statement runs in the owner through its `execute`. Their collection writes are sent to the owner as serializable mutations and committed there atomically. Followers cannot open adapter transactions (`FollowerWriteError`), and writing through the query builder from a follower bypasses the outbox, so it is unsupported. When the owner closes or crashes, the next tab reopens the persisted database. Requests in flight are re-sent to it, and retried writes are applied at most once. Requests fail with `StorageOwnerUnavailableError` only when no owner answers. Exclusive storage requires Web Locks and `BroadcastChannel`; without them `ready` rejects with `CoordinationUnavailableError`.
- `sharing: "shared"` is for engines that are already shared and transactional across contexts. Every tab calls `open`; only sync leadership is elected. Without Web Locks it falls back to the outbox lease when the store supports cross-context leases, and otherwise every tab syncs, so provider writes must be idempotent.
- `coordinateTabs: false`, Node, and other non-browser runtimes use a single owning context with no cross-tab traffic.

Writes and pulled changes are announced once, by the context that committed them, over `BroadcastChannel`. Receivers republish them as remote events and never re-broadcast, so live queries in every tab refresh. `client.storageRole` and `subscribeStorageRole()` report whether this tab owns the storage. Client-side coordination is not a substitute for server-side conflict detection.

Outbox stores return events in deterministic `createdAt`, then event-ID order. Keep event IDs stable and unique so same-time events have a consistent replay order.

Provider `pull` implementations should pass listener failures to the optional `onError` callback. Core reports the failure and retries the pull stream with capped backoff; stopping sync cancels the retry. Checkpoints remain tied to successfully committed local changes.

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
