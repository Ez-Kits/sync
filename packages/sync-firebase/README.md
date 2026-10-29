# @ez-kits/sync-firebase

Firebase provider adapters for `@ez-kits/sync-client-core`. Import only the provider entry point you use:

```ts
import { createFirestoreSyncAdapter } from "@ez-kits/sync-firebase/sync-firestore";
import { createRealtimeDBSyncAdapter } from "@ez-kits/sync-firebase/sync-realtime-db";
```

Each provider config maps a local collection to a Firestore collection path or Realtime Database path. Configure stable ID resolution and serializers whenever remote document shapes differ from local rows. Pushes are acknowledged only after Firebase writes complete, and a push resolves only after core has removed the acknowledged events from the outbox (`await commitChanges(...)`), so the next push never re-reads them. Retry safety depends on idempotent IDs and writes.

`resolveDocumentId` / `resolveRecordId` address every pushed event, deletes included, so a delete reaches the same document or record as its creates and updates (`serializeDelete` still receives the local id). Large pushes are acknowledged as they progress: Firestore acknowledges each batch of up to 500 writes once it commits, before committing the next, so a failed batch leaves only its own and later events in the outbox. The Realtime Database adapter coalesces the events of each record, in outbox order, into one multipath `update` (a create replaces the record; updates and deletes merge their top-level fields into it), and splits the push into several updates, written and acknowledged in order, when record paths would nest (for example ids containing `/`) or a field key is itself a `/` path.

Stopping a pull removes its listeners: Realtime Database listeners are detached through the unsubscribe functions `onChildAdded`, `onChildChanged`, and `onChildRemoved` return, so a stopped or retried pull, or a tab that stopped leading, receives no further events.

Pull listener failures are reported to the core client and the listener is retried with capped backoff. Checkpoints advance only after incoming changes are committed locally.

## API naming migration

The old sync-options API names are removed. Use `SyncAdapter`, set `syncAdapter` on a client or collection, and use the `createFirestoreSyncAdapter` / `createRealtimeDBSyncAdapter` factories. Per-collection builders are named `defineFirestoreCollectionSyncAdapterConfig` and `defineRealtimeDBCollectionSyncAdapterConfig`.

## Checkpoints

Checkpoint values and queries are application/provider-specific. Firestore clients should order by a stable cursor and define tie-breaking for equal values. If records can be updated without advancing that cursor, the query can miss changes; maintain an updated version field on every write or choose a cursor strategy that covers updates. RTDB clients should provide a pull query builder when resuming from a checkpoint; the default listener starts at the configured collection path and receives its current children.

Deletes use tombstones by default (`deleted: true` with `deletedAt`) so listeners can propagate removals. Configure `serializeDelete`, `isDeleted`, and `deserializeDeleteId` to match the security rules and data model. Physical removals observed by listeners are also translated into local deletes.

## Security and deployment

Configure Firebase authentication and restrictive Firestore/Realtime Database security rules in the application. Never treat client configuration as authorization. Test reads, creates, updates, and tombstones under the production rules before release. The adapter does not install or manage Firebase rules.

The Firebase Emulator Suite integration tests run with authenticated anonymous users against user-scoped test rules. They cover retry-safe pushes, updates, tombstones, permission-denied reads/writes, and Firestore checkpoint ties and cursor advancement. Run them with `pnpm --filter @ez-kits/sync-firebase test:emulator`. These fixtures exercise the adapter's release behavior; each host app must also verify its own deployed rules and authentication configuration.

## Development

```bash
pnpm --filter @ez-kits/sync-firebase build
pnpm --filter @ez-kits/sync-firebase test
```
