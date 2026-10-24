# @ez-kits/sync-firebase

Firebase provider adapters for `@ez-kits/sync-client-core`. Import only the provider entry point you use:

```ts
import { createFirestoreSyncAdapter } from "@ez-kits/sync-firebase/sync-firestore";
import { createRealtimeDBSyncAdapter } from "@ez-kits/sync-firebase/sync-realtime-db";
```

Each provider config maps a local collection to a Firestore collection path or Realtime Database path. Configure stable ID resolution and serializers whenever remote document shapes differ from local rows. Pushes are acknowledged only after Firebase writes complete; retry safety depends on idempotent IDs and writes.

## API naming migration

The old sync-options API names are removed. Use `SyncAdapter`, set `syncAdapter` on a client or collection, and use the `createFirestoreSyncAdapter` / `createRealtimeDBSyncAdapter` factories. Per-collection builders are named `defineFirestoreCollectionSyncAdapterConfig` and `defineRealtimeDBCollectionSyncAdapterConfig`.

## Checkpoints

Checkpoint values and queries are application/provider-specific. Firestore clients should order by a stable cursor and define tie-breaking for equal values. If records can be updated without advancing that cursor, the query can miss changes; maintain an updated version field on every write or choose a cursor strategy that covers updates. RTDB clients should provide a pull query builder when resuming from a checkpoint; the default listener starts at the configured collection path and receives its current children.

Deletes use tombstones by default (`deleted: true` with `deletedAt`) so listeners can propagate removals. Configure `serializeDelete`, `isDeleted`, and `deserializeDeleteId` to match the security rules and data model. Physical removals observed by listeners are also translated into local deletes.

## Security and deployment

Configure Firebase authentication and restrictive Firestore/Realtime Database security rules in the application. Never treat client configuration as authorization. Test reads, creates, updates, and tombstones under the production rules before release. The adapter does not install or manage Firebase rules.

## Development

```bash
pnpm --filter @ez-kits/sync-firebase build
pnpm --filter @ez-kits/sync-firebase test
```
