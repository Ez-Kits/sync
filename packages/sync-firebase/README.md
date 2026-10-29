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

## Rejected writes

Pushes classify Firebase errors so that one refused write cannot block sync. A write Firebase refuses as sent fails the push with core's `PushRejectedError` (`message` names the code, `cause` is the original Firebase error); core then pushes the remaining events in smaller pieces, so every other write still goes through, and parks the refused one: it stays in the outbox, later writes of its record wait behind it, and it is retried with a backoff and whenever sync starts. It is reported once through the client's `onPushRejected` (see the core README). Permanent:

- Firestore `permission-denied` (security rules, including their validation), `invalid-argument` (invalid data or path, also when `WriteBatch.set` throws it before committing), `out-of-range` and `failed-precondition`.
- Realtime Database `PERMISSION_DENIED` (rules, `.validate` included), and updates the SDK's own key and value validation throws synchronously.

Everything else is retried with backoff: `unavailable`, `deadline-exceeded`, `cancelled`, `aborted`, `internal` and `unknown` are transient transport or backend conditions, `resource-exhausted` is a quota that refills, `unauthenticated` (and RTDB `EXPIRED_TOKEN` / `INVALID_TOKEN`) is fixed by signing in again, and unlisted codes are retried rather than risk dropping a write.

Rules that require a signed-in user refuse writes from a signed-out client with `permission-denied`. This only parks those writes, nothing is lost: Firebase Auth restores the session asynchronously after page load, and if sync started first, the parked writes are pushed, in order, by the next retry or sync start. Call `client.retryRejectedPushes()` from `onAuthStateChanged` once a user is signed in to push them at once. A write that can never succeed (rules or data that will not change) stays parked until the application calls `rejection.discard()` from `onPushRejected`, which removes it from the outbox; the local row keeps its value, so revert it (for example re-read the document with `getDoc` / `get` and write the remote state back locally) or let the user correct it.

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
