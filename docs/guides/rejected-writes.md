# Rejected writes

Sometimes the backend **refuses** a write for good: security rules deny it, validation fails, or the user is signed out. Sending the same write again would fail again.

EzSync never drops such a write by itself. It **parks** it:

- The write stays in the outbox. The local row keeps its value.
- Later writes **of the same record** wait behind it, so the record's order is kept.
- Writes of **other records** keep syncing normally.
- The parked write is retried after a growing delay (5 seconds, doubling up to 60 seconds), every time sync starts, and whenever you call `client.retryRejectedPushes()`.
- You are told about it once, through `onPushRejected`.

Errors that are **not** permanent (network down, server busy, expired token) are not parked; they are retried with normal backoff.

## Get notified

```ts
const client = createSyncClient({
  collections: [todosCollection],
  dbAdapter,
  syncAdapter,
  onPushRejected: (rejection) => {
    console.warn("The server refused a write:", rejection.event, rejection.error);
    showToast("Some changes could not be saved to the server.");
  },
});
```

`rejection` has:

| Field       | Meaning                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| `event`     | The refused write: `{ type, collection, data }` or `{ type: "delete", collection, id }`. |
| `error`     | The error the backend returned (for Firebase, a `PushRejectedError` with the code).      |
| `discard()` | Remove this write from the outbox for good.                                              |

## Common case: the user was signed out

With rules that require a signed-in user, every write made while signed out is refused and parked. Push them as soon as the user signs in:

```ts
import { getAuth, onAuthStateChanged } from "firebase/auth";

onAuthStateChanged(getAuth(), (user) => {
  if (user) client.retryRejectedPushes();
});
```

A retry starts by sending **one** parked write. If it is refused again, the retry stops there, so a client whose writes are all refused costs only one request per retry.

## Writes that can never succeed

If a write will never be accepted (for example the user lost access to a project), discard it and fix the local data:

```ts
onPushRejected: async (rejection) => {
  if (isForever(rejection.error)) {
    await rejection.discard();
    // The local row still has the refused value. Put it back in a valid state,
    // for example by re-reading the document from the server and writing it locally,
    // or by asking the user to edit and save again.
  }
},
```

- `discard()` removes the event as if the server had accepted it. Later writes of the record are then pushed.
- It does **not** undo the local row. That is your app's decision.
- If this tab is no longer the leader, `discard()` rejects with `LeaderChangedError` and the write stays in the outbox. The new leader will push it again and report a new rejection.

## For sync adapter authors

To mark a refusal as permanent, throw a `PushRejectedError` (or any error with `permanent: true`) from `push`. EzSync then narrows a refused batch down to the single refused write by pushing halves of it, in order, and parks only that one. See [Custom sync adapter](../extending/custom-sync-adapter.md#errors).

## Good to know

- Parking is remembered only in the leader's memory. After a reload or a leader change, parked writes are simply pushed again, and reported again if refused. That is safe, since the server stored nothing for them.
- A write that is refused every time delays the retries of other parked records a little whenever it is the one being tried. Discard writes that can never succeed.
