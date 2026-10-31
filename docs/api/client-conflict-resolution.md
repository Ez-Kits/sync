# `@ez-kits/sync-client-conflict-resolution`

Ready-made conflict policies. Each function returns a plain `ConflictResolution` to pass as `resolveConflict` to `createSyncClient`. Provider-neutral.

```bash
npm install @ez-kits/sync-client-conflict-resolution
```

Guide: [Conflict resolution](../guides/conflict-resolution.md).

## `localWins()`

Always `"local"`: skip the remote change, push the local writes. Same as having no resolver.

## `remoteWins()`

Always `"remote"`: apply the remote change, discard the record's unpushed local writes.

## `lastWriteWins(options)`

Compare two versions; the higher one wins.

| Option                     | Type                                                            | Description                                                               |
| -------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `getLocalVersion(local)`   | `(local \| undefined) => number \| string \| Date \| undefined` | The local record's version.                                               |
| `getRemoteVersion(remote)` | `(remote event) => number \| string \| Date \| undefined`       | The remote event's version.                                               |
| `onMissingVersion`         | `"local" \| "remote"`                                           | Used when a version is missing, invalid, or the two have different types. |
| `onTie`                    | `"local" \| "remote"`                                           | Used when both versions are equal.                                        |

`Date`s are compared by time, numbers numerically, strings lexicographically. `NaN` and invalid dates count as missing.

```ts
lastWriteWins({
  getLocalVersion: (local) => local?.updatedAt,
  getRemoteVersion: (remote) =>
    remote.type === "delete" ? remote.deletedAt : remote.data.updatedAt,
  onMissingVersion: "local",
  onTie: "local",
});
```

## `mergeFields(options)`

Shallow merge: start from `{ ...local, ...remote }`, then replace each configured field with `merge(localValue, remoteValue)`. Returns `{ data }`, which is stored locally and pushed.

| Option           | Type                                         | Description                             |
| ---------------- | -------------------------------------------- | --------------------------------------- |
| `fields`         | `Record<string, (local, remote) => unknown>` | The fields to merge and how.            |
| `onMissingLocal` | `"local" \| "remote"`                        | Used when there is no local row.        |
| `onRemoteDelete` | `"local" \| "remote"`                        | Used when the remote event is a delete. |

When the remote data is not an object, the result is `"remote"`.

## `deleteVsUpdate(options)`

| Option           | Type                  | Description                                                                               |
| ---------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| `onRemoteDelete` | `"local" \| "remote"` | The remote side deleted a record that has local writes.                                   |
| `onMissingLocal` | `"local" \| "remote"` | The remote side changed a record that has no local row (it was probably deleted locally). |

Every other conflict returns `"remote"`.

## `manualResolution(options)`

| Option                | Type                                                           | Description                                          |
| --------------------- | -------------------------------------------------------------- | ---------------------------------------------------- |
| `onConflict(context)` | `({ remote, local }) => decision \| undefined \| Promise<...>` | Your decision, or `undefined` for "no decision yet". |
| `fallback`            | `"local" \| "remote" \| { data }`                              | Used when `onConflict` returns `undefined`.          |

The resolver runs inside the pull transaction: decide quickly, do not query the database, and keep any "review later" state yourself.

## Types

| Export                                                                                                      | Description                                   |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `ConflictDecision`                                                                                          | `"local" \| "remote" \| { data: unknown }`    |
| `ConflictContext<C>`                                                                                        | `{ remote, local }`, the resolver's argument. |
| `ConflictVersion`                                                                                           | `number \| string \| Date`                    |
| `ComparableConflictVersion`                                                                                 | `number \| string`                            |
| `LastWriteWinsOptions`, `FieldMergeOptions`, `FieldMerge`, `DeleteUpdateOptions`, `ManualResolutionOptions` | Option types.                                 |
| `ConflictResolution`, `ChangeBusEvent`, `ChangeBusEventDataMap`                                             | Re-exported from `@ez-kits/sync-client-core`. |
