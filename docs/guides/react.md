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
import { useCallback } from "react";
import { useLiveQuery } from "./sync";

function OpenTodos({ search }: { search: string }) {
  const { data, isPending, error } = useLiveQuery({
    collections: ["todos"],
    query: useCallback(
      (db) =>
        db.query.todos.findMany({
          where: { completed: false, ...(search ? { title: { like: `%${search}%` } } : {}) },
          orderBy: { updatedAt: "desc" },
        }),
      [search],
    ),
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
- `isPending` is `true` while a query runs.
- `error` is set when the query throws.

> **Keep `query` stable.** Wrap it in `useCallback` with the values it uses as dependencies, or define it outside the component. A new function on every render starts a new live query on every render. `collections` may be a new array each render; it is compared by content.

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

## Notes

- The client is created when the module loads, before React renders. That is intended: the storage worker starts as early as possible.
- `StrictMode` is fine. The client lives outside React, so double-mounting does not create a second client.
- To show an error screen when the database cannot open, you can `await dbStorage.ready` before rendering, and render a message if it rejects.
- A complete app is in [examples/todo-react-drizzle-firestore](../../examples/todo-react-drizzle-firestore) (Drizzle) and [examples/todo-react-typeorm-firestore](../../examples/todo-react-typeorm-firestore) (TypeORM).
