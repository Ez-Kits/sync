# Conflict resolution

## What is a conflict?

A **conflict** happens when a remote change arrives for a record that has **local writes not pushed yet**.

Example: you edit a todo on your laptop while it is offline. Meanwhile, the same todo is edited on your phone. When the laptop comes back online, it pulls the phone's change, but it still has its own unpushed edit. Which one wins?

Records **without** unpushed local writes are never in conflict: they always take the remote change.

## The default: local wins

Without a resolver, the **local** writes win. The remote change is set aside, and the local writes are pushed over it. This is predictable and never loses what the user just typed on this device, but the other device's edit is overwritten.

## Choosing a policy

Pass `resolveConflict` to the client. The `@ez-kits/sync-conflict-resolution` package has ready-made policies:

```bash
npm install @ez-kits/sync-conflict-resolution
```

### Last write wins (recommended for most apps)

The newer edit wins, by a version you choose, typically an `updatedAt` timestamp you set on every write:

```ts
import { lastWriteWins } from "@ez-kits/sync-conflict-resolution";

const client = createSyncClient({
  collections: [todosCollection],
  dbAdapter,
  syncAdapter,
  resolveConflict: lastWriteWins({
    getLocalVersion: (local) => local?.updatedAt,
    getRemoteVersion: (remote) =>
      remote.type === "delete" ? remote.deletedAt : remote.data.updatedAt,
    onMissingVersion: "local", // a version is missing: keep local
    onTie: "local", // same version: keep local
  }),
});
```

Versions may be numbers, strings (compared alphabetically) or `Date`s. `onMissingVersion` and `onTie` are required, so you decide the edge cases on purpose.

> Device clocks can be wrong. If that matters, compare a version the server assigns (for example a Firestore server timestamp, converted to a number when pulled) or a counter.

### Merge fields

Start from the remote record and merge chosen fields with your own function:

```ts
import { mergeFields } from "@ez-kits/sync-conflict-resolution";

resolveConflict: mergeFields({
  fields: {
    // keep the longer title
    title: (local, remote) => (String(local).length >= String(remote).length ? local : remote),
    // completed if either side completed it
    completed: (local, remote) => Boolean(local) || Boolean(remote),
  },
  onMissingLocal: "remote", // the local row is gone
  onRemoteDelete: "remote", // the remote side deleted the record
}),
```

The merged record is saved locally **and pushed**, so both sides end up with it. The merge is shallow (top-level fields only).

### Other policies

| Policy                                               | Decision                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `localWins()`                                        | Always keep local (same as no resolver).                               |
| `remoteWins()`                                       | Always take remote, and drop the local unpushed writes of that record. |
| `deleteVsUpdate({ onRemoteDelete, onMissingLocal })` | Decide delete-versus-edit cases; other conflicts take remote.          |
| `manualResolution({ onConflict, fallback })`         | Call your function; use `fallback` when it returns `undefined`.        |

See the [API reference](../api/sync-conflict-resolution.md) for every option.

> **Tip: write the policy inline**, as `resolveConflict: lastWriteWins({ ... })`. TypeScript then infers your collections' types for `local` and `remote` in the callbacks. A policy stored in a variable first (`const policy = mergeFields({ ... })`) is accepted too, with untyped (`any`) `local` and `remote`; give it the type argument (`lastWriteWins<DataMap>({ ... })`) to keep them typed.

## Writing your own resolver

A resolver is a function that receives the remote change and the local record, and returns a decision:

```ts
resolveConflict: ({ remote, local }) => {
  if (remote.collection === "todos" && remote.type !== "delete" && local?.completed) {
    return "local"; // never un-complete a todo
  }
  return "remote";
},
```

- `remote` is the pulled event: `{ type: "create" | "update", collection, data }` or `{ type: "delete", collection, id, deletedAt? }`.
- `local` is the current local row, or `undefined` if there is none (for example it was deleted locally).

It returns one of:

| Return value | What happens                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `"local"`    | Skip the remote change. The local writes are pushed later and win on the server.                                           |
| `"remote"`   | Apply the remote change and **discard** the record's unpushed local writes.                                                |
| `{ data }`   | Save `data` locally and push it in place of the unpushed local writes. After a remote delete, `data` recreates the record. |

The resolver may be `async`.

### Rules for resolvers

- **Do not query the database** inside a resolver: not through the client, a collection, a live query or the ORM. It runs inside the transaction that applies the pulled batch, and a query would wait for that same transaction: a deadlock until the transaction times out. Decide from `remote` and `local` only.
- **Be quick.** While it runs, the database is busy for every tab. An `async` resolver that waits for the user holds everything; use `manualResolution` with a `fallback` instead, and store conflicts to review later yourself.
- **Throwing is allowed but costly.** A thrown error fails the whole batch; the pull restarts from the last checkpoint and the conflict is resolved again.

## What happens after a decision

- A remote change skipped because of `"local"` is **kept** in the database (the latest one per record). Once the server has confirmed every local write of that record, the kept change is applied. This handles the server's "echo" of your own write, with server-set fields, arriving before the push is confirmed.
- A push that was already on its way cannot be recalled. Both sides still converge once the pull brings the final state back.
