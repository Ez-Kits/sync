# `@ez-kits/sync-client-react`

React bindings: a provider and typed hooks for one sync client. Requires React 19.

```bash
npm install @ez-kits/sync-client-react
```

See the [React guide](../guides/react.md) for usage patterns.

## `createSyncClientReact(options)`

```ts
import { createSyncClientReact } from "@ez-kits/sync-client-react";

export const { syncClient, SyncClientProvider, useSyncClient, useLiveQuery } =
  createSyncClientReact({ collections: [todosCollection], dbAdapter, syncAdapter });
```

`options` are exactly [`SyncClientConfig`](client-core.md#syncclientconfig). The function calls `createSyncClient(options)` once and returns:

| Value                | Type                                      | Description                                                |
| -------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| `syncClient`         | `SyncClient`                              | The client. Usable outside React.                          |
| `SyncClientProvider` | `ComponentType<{ children: ReactNode }>`  | Provides `syncClient` to the hooks below.                  |
| `useSyncClient`      | `() => SyncClient`                        | The client. Throws when used outside `SyncClientProvider`. |
| `useLiveQuery`       | `(options) => { data, isPending, error }` | A live query bound to the component's lifetime.            |

## `useLiveQuery(options)`

```ts
const { data, isPending, error } = useLiveQuery({
  collections: ["todos"],
  query: (db, schema) => db.select().from(schema.todos).where(eq(schema.todos.listId, listId)),
  deps: [listId],
});
```

| Option        | Type                                             | Description                                                                                   |
| ------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `collections` | collection names                                 | Re-run when these change. Omit to re-run on any change. Compared by content.                  |
| `query`       | `(queryBuilder, querySchema) => T \| Promise<T>` | The ORM query. Need not be stable: each run uses the latest function.                         |
| `deps`        | `readonly unknown[]`                             | The props and state `query` reads. A change (by `Object.is`) restarts the live query at once. |

| Result      | Type                 | Description                                                |
| ----------- | -------------------- | ---------------------------------------------------------- |
| `data`      | `T \| undefined`     | The latest result; `undefined` before the first one.       |
| `isPending` | `boolean`            | `true` until the first result, and while the query reruns. |
| `error`     | `Error \| undefined` | Set when the query threw; cleared when it runs again.      |

## Types

| Export                         | Description                      |
| ------------------------------ | -------------------------------- |
| `CreateSyncClientReactOptions` | Same as `SyncClientConfig`.      |
| `CreateSyncClientReactResult`  | The returned object.             |
| `UseLiveQuery`                 | The type of `useLiveQuery`.      |
| `UseLiveQueryOptions`          | `{ collections?, query, deps? }` |
| `UseLiveQueryResult`           | `{ data, isPending, error }`     |
