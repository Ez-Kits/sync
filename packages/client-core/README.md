# @ez-kits/sync-client-core

Provider-neutral client sync primitives for local-first applications. Core defines the collection, database, checkpoint, and outbox contracts; provider integrations implement `SyncAdapter` without adding provider dependencies to this package.

## Client lifecycle

Create a client with collections, a database adapter, checkpoint storage, and an optional provider sync adapter. Call `startSync()` after app initialization and `stopSync()` when the client is no longer active. Network events pause and resume browser sync automatically. Subscribe to status with `subscribeStatus()` or pass `onSyncStatus` to receive `starting`, `syncing`, `idle`, `offline`, `stopped`, and `error` updates.

Implement a `SyncAdapter` with provider `pull` and `push` methods. `pull` and `push` may return promises; push should resolve only after the provider has durably accepted the supplied events and invoke `commitChanges` only after success. Core serializes push batches and retries failures with bounded exponential delays. Failed events are not acknowledged and remain in the outbox for a later sync start or subsequent push.

## Persistence guarantees

The default outbox uses IndexedDB in browsers and memory where IndexedDB is unavailable. Supply `localChangeStore` for another durable implementation. Local database writes and outbox writes are sequential by default, so a process failure between the two can leave local data without a pending event. A database adapter may implement `commitLocalMutation` to atomically perform both operations. Adapters that cannot provide this capability should describe their durability as best effort.

An adapter may implement `getOptional` to distinguish an absent record from a database failure. `get` remains available when callers require the row to exist.

## Conflicts and browser tabs

Pass `resolveConflict` to inspect an incoming remote event when the same record has a locally pending write. Return `"remote"`, `"local"`, or `{ data }`. With no hook, remote changes are applied in arrival order. Applications should include comparable version metadata if they need a stronger deterministic winner policy.

Browser clients coordinate a sync leader through the outbox lease when the configured store supports leases. Use a unique `coordinationKey` for each shared local database. `coordinateTabs: false` disables this behavior. Cross-tab change notifications use `BroadcastChannel` when available. Lease coordination is not a substitute for server-side conflict detection.

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
