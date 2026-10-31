# Node.js and tests

In the browser, the database runs in a worker shared by all tabs. In Node.js scripts, unit tests, Electron main processes or any single-context app, you can skip the worker and run the engine **in the current context** with `createLocalDBStorage`. Everything else (DB adapter, sync client, sync adapter) stays the same.

## `createLocalDBStorage`

```ts
import { createLocalDBStorage } from "@ez-kits/sync-client-core";
import { openSqlJsEngine } from "@ez-kits/sync-client-storage-sqljs/worker";
import { migrate } from "./db/migrations";

const dbStorage = createLocalDBStorage({
  dialect: "sqlite", // must match the engine
  key: "my-script",
  open: async () => {
    const engine = await openSqlJsEngine(); // in memory; no wasmUrl needed in Node
    await migrate(engine);
    return engine;
  },
});
```

- `open` runs once, right away. This context is always the **leader**.
- The `/worker` entry points (`openSqlJsEngine`, `openSqliteWasmEngine`, `openPGliteEngine`) are plain functions; they work outside a worker too.
- Transactions are still serialized and still rolled back after `transactionTimeoutMs` (10 seconds) of inactivity.

With PGlite (Postgres):

```ts
import { openPGliteEngine } from "@ez-kits/sync-client-storage-pglite/worker";

const dbStorage = createLocalDBStorage({
  dialect: "postgres",
  open: () => openPGliteEngine(), // in memory; pass { dataDir: "./data" } to keep it on disk
});
```

## A unit test

A test for code that uses the sync client, with an in-memory database and no backend:

```ts
// todos.test.ts
import { afterEach, expect, test } from "vitest";
import { createLocalDBStorage, createSyncClient } from "@ez-kits/sync-client-core";
import { defineDrizzleCollection } from "@ez-kits/sync-client-drizzle-adapter";
import { createDrizzleSqliteDBAdapter } from "@ez-kits/sync-client-drizzle-adapter/sqlite";
import { openSqlJsEngine } from "@ez-kits/sync-client-storage-sqljs/worker";
import { todos } from "../src/db/schema";
import { migrate } from "../src/db/migrations";

const todosCollection = defineDrizzleCollection({ name: "todos", table: todos });

function createTestClient() {
  const dbStorage = createLocalDBStorage({
    dialect: "sqlite",
    key: crypto.randomUUID(), // a unique key per test: clients with the same key talk to each other
    open: async () => {
      const engine = await openSqlJsEngine();
      await migrate(engine);
      return engine;
    },
  });
  const dbAdapter = createDrizzleSqliteDBAdapter({ dbStorage, collections: [todosCollection] });
  return createSyncClient({ collections: [todosCollection], dbAdapter });
}

let client: ReturnType<typeof createTestClient>;
afterEach(() => client.dispose());

test("inserts a todo", async () => {
  client = createTestClient();
  await client.collections.todos.insert({ id: "1", title: "Test", completed: false, updatedAt: 1 });
  expect(await client.collections.todos.getMany()).toHaveLength(1);
});
```

Tips:

- **Use a unique `key` per client** in tests. Clients in one process with the same key share change notifications through `BroadcastChannel`.
- **Always `dispose()`** the client at the end of a test, so the engine closes.
- To test sync, pass a fake `syncAdapter`. A minimal one is in [Custom sync adapter](../extending/custom-sync-adapter.md#a-fake-adapter-for-tests).
- sql.js loads its `.wasm` file from `node_modules` by itself in Node. In a jsdom or browser-like test environment, pass `wasmUrl` (a file path) or a preloaded module through `sqlJs`.

## Running in a worker without multi-tab coordination

`createWorkerDBStorage` (and the `create...Storage` helpers built on it) needs **Web Locks** and **BroadcastChannel**. Where they are missing, its `ready` promise rejects with `CoordinationUnavailableError` instead of running without coordination. Use `createLocalDBStorage` there.
