# React

`@ez-kits/sync-client-react` gives you a provider and two hooks.

```bash
npm install @ez-kits/sync-client-react
```

## Set up

`createSyncClientReact` takes **exactly the same options** as `createSyncClient`, creates the client, and returns typed React helpers bound to it. Call it once, at module level:

```ts
// src/sync.ts
import { createSyncClientReact } from "@ez-kits/sync-client-react";

export const { syncClient, SyncClientProvider, useSyncClient, useLiveQuery } =
  createSyncClientReact({
    collections: [todosCollection],
    dbAdapter,
    syncAdapter, // optional
  });
```

Wrap your app in the provider:

```tsx
// src/main.tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SyncClientProvider } from "./sync";

createRoot(document.getElementById("root")!).render(
  <SyncClientProvider>
    <App />
  </SyncClientProvider>,
);
```

| Returned value       | What it is                                                                           |
| -------------------- | ------------------------------------------------------------------------------------ |
| `syncClient`         | The sync client itself. Use it outside components (for example in an auth listener). |
| `SyncClientProvider` | A provider component. Hooks must be used inside it.                                  |
| `useSyncClient()`    | Returns the client inside a component.                                               |
| `useLiveQuery(opts)` | Runs a live query and returns `{ data, isPending, error }`.                          |

## Read data with `useLiveQuery`

```tsx
import { useLiveQuery } from "./sync";

function OpenTodos({ search }: { search: string }) {
  const { data, isPending, error } = useLiveQuery({
    collections: ["todos"],
    query: (db) =>
      db.query.todos.findMany({
        where: { completed: false, ...(search ? { title: { like: `%${search}%` } } : {}) },
        orderBy: { updatedAt: "desc" },
      }),
    // The props and state `query` reads: a change reruns it at once.
    deps: [search],
  });

  if (error) return <p>Could not load: {error.message}</p>;
  if (!data) return <p>Loading…</p>;
  return (
    <ul>
      {data.map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
    </ul>
  );
}
```

- `query` gets the ORM query builder and the schema, exactly like [`client.liveQuery`](reading-data.md#live-queries).
- `data` is `undefined` until the first result arrives.
- `isPending` is `true` until the first result arrives, and while the query reruns.
- `error` is set when the query throws.

> **List what `query` reads in `deps`.** `query` need not be stable: each run uses the latest function, and a new function alone does not restart the live query. When a value in `deps` changes (compared with `Object.is`, like `useEffect` dependencies), the live query restarts and reruns at once. A value missing from `deps` is only picked up on the next change of the watched collections. `collections` may be a new array each render; it is compared by content.

## Write data

Use the client from `useSyncClient()`:

```tsx
function AddTodo() {
  const client = useSyncClient();
  return (
    <button
      onClick={() =>
        client.collections.todos.insert({
          id: crypto.randomUUID(),
          title: "New todo",
          completed: false,
          updatedAt: Date.now(),
        })
      }
    >
      Add
    </button>
  );
}
```

You do not need to refresh anything after a write: every live query that uses the collection re-runs by itself, in every tab.

## Start sync

Start sync from an effect (or from your auth listener):

```tsx
function SyncController() {
  const client = useSyncClient();
  useEffect(() => {
    client.startSync();
    return () => client.stopSync();
  }, [client]);
  return null;
}
```

## Show sync status and role

`subscribeStatus` and `subscribeRole` call the listener right away and return an unsubscribe function, so they fit `useSyncExternalStore` or a simple effect:

```tsx
function SyncBadge() {
  const client = useSyncClient();
  const [status, setStatus] = useState("stopped");
  useEffect(() => client.subscribeStatus((event) => setStatus(event.status)), [client]);
  return <span className={`badge badge-${status}`}>{status}</span>;
}

function RoleBadge() {
  const client = useSyncClient();
  const [role, setRole] = useState(client.role);
  useEffect(() => client.subscribeRole(setRole), [client]);
  return <small>{role === "leader" ? "This tab syncs" : "Synced by another tab"}</small>;
}
```

## One client per user

When each user syncs their own data (a per-user Firestore path, or a query that filters by user), give each user their own local database too. Then switching users never mixes rows, pending writes or checkpoints. `createScopedSyncClientReact` builds one client per **scope** from a function:

```ts
// src/sync.ts
import { createScopedSyncClientReact } from "@ez-kits/sync-client-react";

export const { SyncClientProvider, useSyncClient, useLiveQuery } = createScopedSyncClientReact({
  createConfig: (uid: string) => {
    const dbStorage = createSqlJsDBStorage({
      key: `todos:${uid}`, // tabs of the same user share this database
      engineOptions: { indexedDBName: `todos-sqljs:${uid}` },
      worker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
    });
    return {
      collections: [todosCollection],
      dbAdapter: createDrizzleSqliteDBAdapter({ dbStorage, collections: [todosCollection] }),
      syncAdapter: createFirestoreSyncAdapter({
        db: firestore,
        collections: [
          defineFirestoreCollectionSyncAdapterConfig({
            collectionConfig: todosCollection,
            collectionPath: `users/${uid}/todos`,
            ...todoHandlers,
          }),
        ],
      }),
    };
  },
});
```

Collections, handlers and conflict rules stay at module level; only what depends on the user goes in `createConfig`. Render the provider with the current user:

```tsx
function Root() {
  const [uid, setUid] = useState<string>();
  useEffect(() => onAuthStateChanged(getAuth(), (user) => setUid(user?.uid)), []);
  if (!uid) return <SignIn />;
  return (
    <SyncClientProvider scope={uid} fallback={<p>Opening your data…</p>}>
      <App />
    </SyncClientProvider>
  );
}
```

- **Switching users** disposes the previous client and remounts `<App />` with the new one. The hooks work exactly as above.
- **Pending writes are kept.** A user's unpushed writes stay in their database and are pushed the next time that user signs in.
- **Switch only once the user is signed in**, so that security rules do not refuse the first pushes.
- **Every tab must switch.** Firebase Auth's state is shared across tabs, so driving `scope` from `onAuthStateChanged` covers this. A switch of your own can use the `storage` event, as the examples do.
- **When the database cannot open**, the provider throws to the nearest error boundary.

## Notes

- The client is created when the module loads, before React renders. That is intended: the storage worker starts as early as possible.
- `StrictMode` is fine. The client lives outside React, so double-mounting does not create a second client.
- To show an error screen when the database cannot open, you can `await dbStorage.ready` before rendering, and render a message if it rejects.
- With `createScopedSyncClientReact`, clients are created by the provider instead, and there is no module-level `syncClient`.
- A complete app is in [examples/todo-react-drizzle-firestore](../../examples/todo-react-drizzle-firestore) (Drizzle) and [examples/todo-react-typeorm-firestore](../../examples/todo-react-typeorm-firestore) (TypeORM). Both use one client per account, with an account switcher.
