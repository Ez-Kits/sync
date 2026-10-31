# Quick start

In this guide you build a small todo list that:

1. saves todos in a SQLite database inside the browser (it survives a reload and works offline),
2. updates live in every open tab,
3. then syncs with Cloud Firestore.

You will use the recommended starter stack: **Drizzle** + **sql.js** (+ **Firestore**). It assumes a Vite project with TypeScript. If you do not have one yet, create it with `npm create vite@latest my-todos -- --template vanilla-ts` (or `react-ts`).

Install the packages first, as shown in [Installation](installation.md).

## The files you will create

```
src/
├── db/
│   ├── schema.ts       # Step 1: your table, in Drizzle
│   ├── migrations.ts   # Step 2: CREATE TABLE for your table
│   ├── worker.ts       # Step 3: the worker that runs the database
│   └── storage.ts      # Step 4: the DB storage the page uses
├── sync.ts             # Step 5: collections, DB adapter, sync client
└── main.ts             # Step 6: use it
```

## Step 1: describe your table

A **collection** is backed by one table. Describe it with Drizzle, as you normally would:

```ts
// src/db/schema.ts
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const todos = sqliteTable("todos", {
  id: text().primaryKey(),
  title: text().notNull(),
  completed: integer({ mode: "boolean" }).notNull().default(false),
  updatedAt: integer().notNull(),
});

export type Todo = typeof todos.$inferSelect;
```

> **Tip: use string ids** such as `crypto.randomUUID()`. Records are created on many devices at once, so an auto-increment number would collide.

## Step 2: create the table

EzSync creates its own internal tables, but **not yours**. Write a small migration that creates your table if it is missing:

```ts
// src/db/migrations.ts
import type { DBExecutor } from "@ez-kits/sync-client-core";

export async function migrate(db: DBExecutor): Promise<void> {
  await db.exec({
    sql: `CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL
    )`,
    params: [],
    method: "run",
  });
}
```

Keep this SQL in step with `schema.ts`. Later, when you add a column, add an `ALTER TABLE` here. See [Your database schema](../guides/database-schema.md).

## Step 3: the database worker

The database runs inside a **Web Worker**, so heavy queries never freeze your page. Every tab starts this worker; the workers agree on one **leader** that actually opens the database, and the others forward their queries to it. You do not need to manage this; just call `startDBStorageWorker` once:

```ts
// src/db/worker.ts
import { startDBStorageWorker } from "@ez-kits/sync-client-core";
import {
  openSqlJsEngine,
  type SqlJsEngineOptions,
} from "@ez-kits/sync-client-storage-sqljs/worker";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { migrate } from "./migrations";

startDBStorageWorker<SqlJsEngineOptions>(async (options) => {
  // Runs only in the leader's worker.
  const engine = await openSqlJsEngine({ ...options, wasmUrl });
  await migrate(engine);
  return engine;
});
```

`?url` is Vite's way of getting the URL of the `.wasm` file that sql.js needs.

## Step 4: the DB storage

On the page, create the **DB storage**. It starts the worker from Step 3 and gives you one object to run queries on:

```ts
// src/db/storage.ts
import { createSqlJsDBStorage } from "@ez-kits/sync-client-storage-sqljs";

export const dbStorage = createSqlJsDBStorage({
  // Every tab that uses the same key shares the same database.
  key: "my-todos",
  // Where sql.js saves the database between visits. Leave it out for an in-memory database.
  engineOptions: { indexedDBName: "my-todos-db" },
  worker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
});
```

## Step 5: collections, DB adapter and sync client

Now connect the pieces:

```ts
// src/sync.ts
import { createSyncClient } from "@ez-kits/sync-client-core";
import { defineDrizzleCollection } from "@ez-kits/sync-client-drizzle-adapter";
import { createDrizzleSqliteDBAdapter } from "@ez-kits/sync-client-drizzle-adapter/sqlite";
import { dbStorage } from "./db/storage";
import { todos } from "./db/schema";

// 1. A collection: a name, and the table behind it. The primary key is found automatically.
export const todosCollection = defineDrizzleCollection({ name: "todos", table: todos });

// 2. The DB adapter: Drizzle running on the DB storage.
const dbAdapter = createDrizzleSqliteDBAdapter({
  dbStorage,
  collections: [todosCollection],
});

// 3. The sync client: what your app talks to.
export const client = createSyncClient({
  collections: [todosCollection], // the same collections as the adapter
  dbAdapter,
});
```

There is no backend yet. That is fine: the app already works fully offline. You add sync in Step 7.

## Step 6: use it

Write through `client.collections.todos`, and read with a **live query**, which runs again whenever the data changes (in this tab or any other):

```ts
// src/main.ts
import { client } from "./sync";
import { todos } from "./db/schema";

// Show the list, and keep it up to date.
client.liveQuery({
  collections: ["todos"], // re-run when these collections change
  query: (db) => db.select().from(todos).orderBy(todos.updatedAt),
  onData: (rows) => {
    document.querySelector("#app")!.innerHTML = rows
      .map((todo) => `<li>${todo.completed ? "✅" : "⬜️"} ${todo.title}</li>`)
      .join("");
  },
});

// Add a todo when the user presses a button.
document.querySelector("#add")?.addEventListener("click", async () => {
  await client.collections.todos.insert({
    id: crypto.randomUUID(),
    title: "Buy milk",
    completed: false,
    updatedAt: Date.now(),
  });
});
```

Add `<ul id="app"></ul>` and `<button id="add">Add</button>` to your `index.html` and run `npm run dev`.

Now try this:

- Add a few todos, then **reload**. They are still there.
- Open the app in a **second tab** and add a todo there. The first tab updates by itself.

The other operations work the same way:

```ts
await client.collections.todos.update({ id, completed: true, updatedAt: Date.now() }); // only the fields you pass change
await client.collections.todos.delete(id);
const todo = await client.collections.todos.get(id);
const all = await client.collections.todos.getMany();
```

> **Important.** Always write through `client.collections`. If you write with Drizzle directly (`dbAdapter.db.insert(...)`), EzSync does not see the change and never syncs it. Reading with Drizzle is fine.

### Using React instead

Replace `createSyncClient` in `src/sync.ts` with `createSyncClientReact` from `@ez-kits/sync-client-react`:

```ts
// src/sync.ts
import { createSyncClientReact } from "@ez-kits/sync-client-react";
// ...the collection and dbAdapter stay the same...

export const { syncClient, SyncClientProvider, useSyncClient, useLiveQuery } =
  createSyncClientReact({ collections: [todosCollection], dbAdapter });
```

```tsx
// src/App.tsx
import { todos } from "./db/schema";
import { SyncClientProvider, useLiveQuery, useSyncClient } from "./sync";

function TodoList() {
  const client = useSyncClient();
  const { data = [] } = useLiveQuery({
    collections: ["todos"],
    query: (db) => db.select().from(todos).orderBy(todos.updatedAt),
  });

  return (
    <>
      <button
        onClick={() =>
          client.collections.todos.insert({
            id: crypto.randomUUID(),
            title: "Buy milk",
            completed: false,
            updatedAt: Date.now(),
          })
        }
      >
        Add
      </button>
      <ul>
        {data.map((todo) => (
          <li key={todo.id}>{todo.title}</li>
        ))}
      </ul>
    </>
  );
}

export function App() {
  return (
    <SyncClientProvider>
      <TodoList />
    </SyncClientProvider>
  );
}
```

More in the [React guide](../guides/react.md).

## Step 7: sync with Firestore

1. Create a Firebase project and a Firestore database in the [Firebase console](https://console.firebase.google.com). For this tutorial, start Firestore in **test mode** (open rules). Use real [security rules](https://firebase.google.com/docs/firestore/security/get-started) before you ship.
2. Copy your web app config from **Project settings → Your apps**.
3. Create the **sync adapter** and pass it to the client:

```ts
// src/sync.ts
import { createSyncClient } from "@ez-kits/sync-client-core";
import { defineDrizzleCollection } from "@ez-kits/sync-client-drizzle-adapter";
import { createDrizzleSqliteDBAdapter } from "@ez-kits/sync-client-drizzle-adapter/sqlite";
import {
  createFirestoreSyncAdapter,
  defineFirestoreCollectionSyncAdapterConfig,
} from "@ez-kits/sync-client-firebase/sync-firestore";
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { dbStorage } from "./db/storage";
import { todos } from "./db/schema";

const firestore = getFirestore(
  initializeApp({
    apiKey: "...",
    projectId: "...",
    appId: "...",
    // ...the rest of your Firebase config
  }),
);

export const todosCollection = defineDrizzleCollection({ name: "todos", table: todos });

const syncAdapter = createFirestoreSyncAdapter({
  db: firestore,
  collections: [
    defineFirestoreCollectionSyncAdapterConfig({
      collectionConfig: todosCollection,
      collectionPath: "todos", // the Firestore collection
      // Which Firestore document each change goes to.
      resolveRemoteId: (event) =>
        event.type === "delete" ? String(event.id) : String(event.data.id),
      // A starting checkpoint. This simple setup watches the whole collection, so it is unused.
      createCheckpoint: () => null,
    }),
  ],
});

const dbAdapter = createDrizzleSqliteDBAdapter({ dbStorage, collections: [todosCollection] });

export const client = createSyncClient({
  collections: [todosCollection],
  dbAdapter,
  syncAdapter,
});

// Start syncing. Safe to call in every tab: only the leader tab really syncs.
client.startSync();
```

Reload the app. Your todos appear in the Firestore console, and a todo you add in the console appears in the app.

Things to know now that sync is on:

- **Offline is fine.** Writes made offline wait in the outbox and are pushed when the network comes back.
- **Deletes are soft on the server.** A delete sets `deleted: true` and `deletedAt` on the Firestore document instead of removing it, so other devices learn about it. See [Sync with Cloud Firestore](../guides/firestore.md).
- **Watching the whole collection** is simple but re-reads it on every start. For larger data, pull only what changed using a checkpoint, as shown in the [Firestore guide](../guides/firestore.md#pull-only-what-changed).

## What's next

- [How EzSync works](../guides/how-it-works.md): the mental model in ten minutes.
- [Syncing](../guides/syncing.md): status, offline, and many tabs.
- [Conflict resolution](../guides/conflict-resolution.md): what happens when two devices edit the same todo.
- [Rejected writes](../guides/rejected-writes.md): when security rules refuse a write.
- The complete [Drizzle + Firestore example](../../examples/todo-react-drizzle-firestore).
