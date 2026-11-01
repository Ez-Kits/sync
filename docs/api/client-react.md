# `@ez-kits/sync-client-react`

React bindings: a provider and typed hooks for one sync client, or for one client per scope (such as per signed-in user). Requires React 19.

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

| Value                | Type                                      | Description                                                 |
| -------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `syncClient`         | `SyncClient`                              | The client. Usable outside React.                           |
| `SyncClientProvider` | `ComponentType<{ children: ReactNode }>`  | Provides `syncClient` to the hooks below.                   |
| `useSyncClient`      | `() => SyncClient`                        | The client. Throws when used outside `SyncClientProvider`.  |
| `useLiveQuery`       | `(options) => { data, isPending, error }` | A live query bound to the component's lifetime.             |
| `usePendingWrites`   | `() => PendingWrites & { isPending }`     | The client's pending (unpushed) writes, kept current.       |
| `usePullState`       | `(collections?) => UsePullStateResult`    | The pull state of some collections, combined, kept current. |

## `createScopedSyncClientReact(options)`

One client per scope, each with its own database and sync adapter. Use it when every user syncs their own subset of the data into their own local database.

```ts
import { createScopedSyncClientReact } from "@ez-kits/sync-client-react";

export const { SyncClientProvider, useSyncClient, useLiveQuery } = createScopedSyncClientReact({
  createConfig: (uid: string) => {
    const dbStorage = createSqlJsDBStorage({
      key: `todos:${uid}`,
      engineOptions: { indexedDBName: `todos-sqljs:${uid}` },
      worker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
    });
    return {
      collections: [todosCollection],
      dbAdapter: createDrizzleSqliteDBAdapter({ dbStorage, collections: [todosCollection] }),
      syncAdapter: createTodoSyncAdapter(`users/${uid}/todos`),
    };
  },
});
```

| Option         | Type                                  | Description                                                                                                                                                                                 |
| -------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createConfig` | `(scope: string) => SyncClientConfig` | The whole client config of a scope. Give each scope its own storage `key` and database name. Called each time a scope is opened, never while that scope's previous client is still closing. |

It returns `SyncClientProvider`, `useSyncClient`, `useLiveQuery`, `usePendingWrites` and `usePullState`, typed from the config `createConfig` returns. There is no `syncClient`: clients exist only while a provider renders their scope.

### `<SyncClientProvider scope fallback?>`

| Prop       | Type        | Description                                                                                  |
| ---------- | ----------- | -------------------------------------------------------------------------------------------- |
| `scope`    | `string`    | Which client to provide, e.g. the signed-in user's id.                                       |
| `fallback` | `ReactNode` | Rendered while the scope's database opens (`dbStorage.ready`). Default: nothing.             |
| `children` | `ReactNode` | Rendered with the scope's client once its database is ready. Remounted when `scope` changes. |

- A client is created when its scope first renders, and disposed when no provider renders that scope any more. `StrictMode` double mounting reuses the same client.
- Changing `scope` disposes the previous client (which stops its sync and closes its storage) and remounts `children`, so no component state crosses scopes.
- When the scope's database cannot open, the provider throws the error to the nearest error boundary.
- Writes not yet pushed stay in the scope's database and are pushed when the scope is opened again.

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

## `usePendingWrites()`

```ts
const { total, rejected, byCollection, isPending } = usePendingWrites();
```

The client's [`PendingWrites`](client-core.md#pendingwrites), kept current through `subscribePendingWrites`. `isPending` is `true` until the outbox was first read; the counts are `0` until then.

## `usePullState(collections?)`

```ts
const { available, hasRemoteData, caughtUp, progress, collections } = usePullState(["sessions"]);
```

The [pull state](client-core.md#collectionpullstate) of `collections` (default: every pulled one), combined:

| Result          | Description                                                                 |
| --------------- | --------------------------------------------------------------------------- |
| `available`     | Every collection's local data can be shown.                                 |
| `caughtUp`      | Every collection caught up.                                                 |
| `hasRemoteData` | `true` when any collection has remote data, `false` once all answered none. |
| `progress`      | `pulled` summed; `total` summed once every collection has one.              |
| `collections`   | Each collection's own `CollectionPullState`.                                |

## Types

| Export                               | Description                        |
| ------------------------------------ | ---------------------------------- |
| `CreateSyncClientReactOptions`       | Same as `SyncClientConfig`.        |
| `CreateSyncClientReactResult`        | The returned object.               |
| `CreateScopedSyncClientReactOptions` | `{ createConfig }`                 |
| `CreateScopedSyncClientReactResult`  | The scoped form's returned object. |
| `ScopedSyncClientProviderProps`      | `{ scope, fallback?, children }`   |
| `UseLiveQuery`                       | The type of `useLiveQuery`.        |
| `UseLiveQueryOptions`                | `{ collections?, query, deps? }`   |
| `UseLiveQueryResult`                 | `{ data, isPending, error }`       |
| `UsePendingWritesResult`             | `PendingWrites & { isPending }`    |
| `UsePullStateResult`                 | The result of `usePullState`.      |
