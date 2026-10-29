# @ez-kits/sync-conflict-resolution

Provider-neutral built-in conflict policies for EzSync. The package exports resolvers that can be passed directly to the core client's `resolveConflict` option.

```ts
import { lastWriteWins } from "@ez-kits/sync-conflict-resolution";

const client = createSyncClient({
  collections,
  dbAdapter,
  resolveConflict: lastWriteWins({
    getLocalVersion: (local) => local?.updatedAt,
    getRemoteVersion: (remote) => (remote.type === "delete" ? undefined : remote.data.updatedAt),
    onMissingVersion: "remote",
    onTie: "remote",
  }),
});
```

## Built-in policies

- For collection-derived data maps, resolver callbacks type `local` as that collection's persisted
  select/record model, or `undefined` when no local row exists. For a manually authored data map,
  add a `record` type to each collection entry to describe the local row; without one, `local`
  falls back to the create/update payload union.
- `localWins()` / `remoteWins()` choose a side unconditionally for each conflict.
- `lastWriteWins(options)` compares caller-selected numeric, date, or lexically comparable string versions. `onMissingVersion` and `onTie` are required so edge cases are deliberate. Missing/invalid versions and values of incompatible types use `onMissingVersion`. Normalize semantic versions or non-ISO timestamps in the accessors if lexical ordering is not correct for the data.
- `mergeFields(options)` starts with the remote object and applies only the configured shallow field mergers. It does not recursively merge nested values or arrays. Configure behavior for missing local rows and remote deletes.
- `deleteVsUpdate(options)` explicitly selects a result for incoming remote deletes and for remote upserts where the local row is absent. The current resolver context cannot distinguish a local tombstone from an unavailable local row, so choose `onMissingLocal` carefully.
- `manualResolution(options)` delegates to an application callback and uses its explicit fallback when it returns `undefined`. The callback may be asynchronous; errors are allowed to propagate to EzSync's normal sync-error handling.

## Manual/deferred conflicts

The current core resolver contract only accepts `"local"`, `"remote"`, or `{ data }`; it has no durable deferred-conflict state or replay API. `manualResolution` can await an application decision, or the callback can persist conflict context in an application-owned queue and return a fallback. The application remains responsible for storing, presenting, and replaying deferred conflicts. A pending asynchronous decision also holds the current pull batch—and therefore its checkpoint—until it settles.

Core reconciles each decision with the outbox: `"remote"` discards the record's pending local writes, `{ data }` replaces them with one event that pushes the merged data, and `"local"` keeps them. Without a `resolveConflict` callback, a record with pending local writes keeps its local state, as with `localWins()`; records without pending writes always take remote changes. Checkpoints track progress through the remote feed, not whether every incoming event became local data. A resolver that throws fails the pulled batch; the pull resubscribes from the last saved checkpoint and asks again.

## Development

```bash
pnpm --filter @ez-kits/sync-conflict-resolution test
pnpm --filter @ez-kits/sync-conflict-resolution build
```
