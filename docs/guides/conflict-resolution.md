# Conflict resolution

## What is a conflict?

A **conflict** happens when a remote change arrives for a record that has **local writes not pushed yet**.

Example: you edit a todo on your laptop while it is offline. Meanwhile, the same todo is edited on your phone. When the laptop comes back online, it pulls the phone's change, but it still has its own unpushed edit. Which one wins?

Records **without** unpushed local writes are never in conflict: they always take the remote change.

## The default: local wins

Without a resolver, the **local** writes win. The remote change is set aside, and the local writes are pushed over it. This is predictable and never loses what the user just typed on this device, but the other device's edit is overwritten.

## Choosing a policy

Pass `resolveConflict` to the client. The `@ez-kits/sync-client-conflict-resolution` package has ready-made policies:

```bash
npm install @ez-kits/sync-client-conflict-resolution
```

### Last write wins (recommended for most apps)

The newer edit wins, by a version you choose, typically an `updatedAt` timestamp you set on every write:

```ts
import { lastWriteWins } from "@ez-kits/sync-client-conflict-resolution";

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
import { mergeFields } from "@ez-kits/sync-client-conflict-resolution";

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

See the [API reference](../api/client-conflict-resolution.md) for every option.

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

## Exact conflicts with revisions

Without revisions, EzSync cannot tell another device's write from the server's echo of your own: any remote change to a record with pending writes counts as a conflict. A **revision** fixes that without relying on any device clock. It is `rev`, a per-record write counter that your backend's rules enforce and each device tracks locally. Conflicts still go to your `resolveConflict`.

Turn it on per collection. With Firestore, name the field:

```ts
defineFirestoreCollectionSyncAdapterConfig({
  collectionConfig: todosCollection,
  collectionPath: `users/${uid}/todos`,
  revisionField: "rev",
  // ...
});
```

The Realtime Database option has the same name, in `defineRealtimeDBCollectionSyncAdapterConfig`.

Then make your security rules enforce it. Tombstones are updates, so this covers deletes too. For Firestore:

```
function revisionFollows() {
  return request.resource.data.rev
    == (resource == null ? 0 : resource.data.get('rev', 0)) + 1;
}

match /users/{userId}/{collection}/{id} {
  allow read: if request.auth.uid == userId;
  allow create, update: if request.auth.uid == userId
    && collection in ['todos', 'notes']
    && revisionFollows();
}
```

Put the rule on the path your data already lives at, and list the collections that set `revisionField`. Firestore allows a write if any matching rule allows it, so no broader `match` may also allow writes to these documents.

For the Realtime Database, use `.validate`, which a `.write` granted higher up cannot override:

```json
"todos": {
  ".read": "auth != null && auth.uid === $uid",
  ".write": "auth != null && auth.uid === $uid",
  "$todoId": {
    ".validate": "newData.child('rev').val() === (data.child('rev').exists() ? data.child('rev').val() + 1 : 1)"
  }
}
```

`.validate` does not run when a node is removed, so keep the default tombstones: a `serializeDelete` that returns `null` writes no revision.

Records written before you turned revisions on need no migration: both rules count a missing `rev` as 0, and a record gets its `rev` the next time EzSync writes it. Deploy the rule only after every client writes `rev`, because older versions of your app are refused once it is live.

> **The rule is required.** Without it, the server accepts two devices' writes at the same revision. Each device then drops the other's write as a stale echo, `resolveConflict` never runs, and the devices keep different data until the record is written again.
>
> The Firebase console, Cloud Functions and the Admin SDK bypass security rules. Anything that writes these records that way must increase the revision by one itself, for example with `FieldValue.increment(1)` in Firestore or `ServerValue.increment(1)` in the Realtime Database. Otherwise devices drop its change as stale.

`rev` lives only on the server document or node: it is stripped from pulled rows, so you add no column for it.

### How a pulled change is handled

Each device stores the last revision it saw of each record, and numbers its pending writes from there (stored + 1, + 2, ...).

| Pulled `rev`                       | Record has pending writes? | What happens                                                                                                                   |
| ---------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| at or below the stored revision    | either                     | A stale echo: dropped.                                                                                                         |
| above the stored revision          | no                         | Applied, and its `rev` stored.                                                                                                 |
| within the pending writes' numbers | yes                        | Maybe your own echo: kept, and applied after your writes are confirmed only if its `rev` is above the stored revision by then. |
| above the pending writes' numbers  | yes                        | Another device wrote it: a **conflict**, sent to your resolver.                                                                |

If another device's write lands first, the rules refuse your push. EzSync reads the refused records once, sends each to your resolver as a conflict, stores its `rev` and pushes again. A refusal for any other reason stays a [rejected write](rejected-writes.md).

### Decisions on a collection with revisions

`"remote"` and `{ data }` work as above. `"local"` (and having no resolver) **keeps the other device's untouched fields**: the remote row is applied, your pending writes are replayed over it, and they stay pending to be pushed at the next revision.

| Pending write | Replayed over the remote row    |
| ------------- | ------------------------------- |
| create        | Replaces the row.               |
| update        | Merges its fields into the row. |
| delete        | Deletes the row.                |

An update has nothing to merge into after a **remote delete**, so under `"local"` the record **stays deleted** on every device. To bring it back, return `{ data }`, which recreates the record.

### Good to know

- A device drops the echo of its own write. Fields only the server sets (for example a `serverTimestamp()`) do not reach the device that wrote them until another device changes the record.
- If a push reached the server but its confirmation was lost, the retry is refused as out of date and your own write comes back as a conflict. Every decision still converges.
- A record removed without a tombstone (from the console or a function, or by leaving the pull query) arrives with no `rev`. It is handled like a change on a collection without revisions. If the device writes that id again, the rules refuse it and the push-conflict path resets the revision.

## What happens after a decision

- A remote change skipped because of `"local"` is **kept** in the database (the latest one per record). Once the server has confirmed every local write of that record, the kept change is applied. This handles the server's "echo" of your own write, with server-set fields, arriving before the push is confirmed.
- A push that was already on its way cannot be recalled. Both sides still converge once the pull brings the final state back.
