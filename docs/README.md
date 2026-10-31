# EzSync documentation

EzSync is a local-first sync library for TypeScript apps. Your app reads and writes a real SQL database **in the browser**, so it works offline and feels instant. EzSync remembers every local change, sends it to your backend when it can, and brings remote changes back in, across every open tab.

New here? Read the pages under **Start here** in order. It takes about 20 minutes to get a working app.

## Start here

1. [What is EzSync?](getting-started/introduction.md): the idea in plain words, and the five words you need to know.
2. [Installation](getting-started/installation.md): pick your packages and install them.
3. [Quick start](getting-started/quick-start.md): build a working todo list, step by step, then turn on sync.

## Guides

Task-focused pages. Read them when you need them.

| Guide                                                      | Read it when you want to...                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| [How EzSync works](guides/how-it-works.md)                 | understand the layers, tabs, the outbox and what is guaranteed      |
| [Collections and writes](guides/collections-and-writes.md) | define collections and insert, update or delete records             |
| [Reading data](guides/reading-data.md)                     | read records, run ORM queries and keep the UI up to date            |
| [Your database schema](guides/database-schema.md)          | create and migrate your own tables                                  |
| [Choosing a storage engine](guides/storage-engines.md)     | compare sql.js, SQLite WASM and PGlite and set each one up          |
| [Syncing](guides/syncing.md)                               | start and stop sync, show status, handle offline and many tabs      |
| [Sync with Cloud Firestore](guides/firestore.md)           | connect to Firestore, with incremental pulls and deletes            |
| [Sync with Realtime Database](guides/realtime-database.md) | connect to the Firebase Realtime Database                           |
| [Conflict resolution](guides/conflict-resolution.md)       | decide what happens when local and remote edits meet                |
| [Rejected writes](guides/rejected-writes.md)               | handle writes the backend refuses (security rules, signed-out user) |
| [React](guides/react.md)                                   | use the provider and the `useLiveQuery` hook                        |
| [Node.js and tests](guides/node-and-tests.md)              | run EzSync without workers, in scripts and unit tests               |
| [Troubleshooting](guides/troubleshooting.md)               | fix a common error or understand a strange behaviour                |

## API reference

One page per package, listing every export with its options.

| Package                                                                 | What it gives you                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------ |
| [`@ez-kits/sync-client-core`](api/client-core.md)                       | `createSyncClient`, storage helpers, all the contracts |
| [`@ez-kits/sync-client-drizzle-adapter`](api/client-drizzle-adapter.md) | Drizzle ORM adapter (SQLite and Postgres)              |
| [`@ez-kits/sync-client-typeorm-adapter`](api/client-typeorm-adapter.md) | TypeORM adapter (SQLite and Postgres)                  |
| [`@ez-kits/sync-client-react`](api/client-react.md)                     | React provider and hooks                               |
| [`@ez-kits/sync-storage-sqljs`](api/storage-sqljs.md)                   | SQLite (sql.js) in a worker, saved to IndexedDB        |
| [`@ez-kits/sync-storage-sqlite-wasm`](api/storage-sqlite-wasm.md)       | Official SQLite WASM in a worker, saved to OPFS        |
| [`@ez-kits/sync-storage-pglite`](api/storage-pglite.md)                 | Postgres (PGlite) in a worker, saved to IndexedDB      |
| [`@ez-kits/sync-firebase`](api/sync-firebase.md)                        | Sync adapters for Firestore and Realtime Database      |
| [`@ez-kits/sync-conflict-resolution`](api/sync-conflict-resolution.md)  | Ready-made conflict policies                           |

## Extending EzSync

Every layer is a small contract you can implement yourself.

- [Extending overview](extending/overview.md): which layer to build for which need.
- [Custom DB storage](extending/custom-db-storage.md): plug in another database engine.
- [Custom DB adapter](extending/custom-db-adapter.md): support another ORM or a plain SQL layer.
- [Custom sync adapter](extending/custom-sync-adapter.md): sync with your own backend (REST, WebSocket, Supabase, ...).

## More

- [Architecture decisions](../architecture.md): why EzSync works the way it does, with its guarantees and trade-offs.
- [Examples](../examples): complete todo apps with React, Drizzle or TypeORM, and Firestore.

> **Status.** EzSync is approaching a stable API but is not there yet. Expect breaking changes between releases.

## Notes for AI agents

These docs are written to be read by people and by coding agents. If you are an agent working on an app that uses EzSync, these rules prevent the most common mistakes:

- A working setup always has four parts: **collections**, a **DB storage**, a **DB adapter** of the same dialect, and a **sync client**. A **sync adapter** is optional (without it the app is local-only).
- Pass the **same collections** to the DB adapter and to `createSyncClient` / `createSyncClientReact`. Inline (`collections: [todos]`) or from a variable (`const collections = [todos]`) both work.
- Write through `client.collections.<name>.insert / update / delete`. Writing with the ORM (`dbAdapter.db`) directly skips the outbox, so the change is never synced.
- EzSync creates **its own** tables (`ez_sync_*`). The app creates **its own** tables, usually in the storage worker's `open` function. See [Your database schema](guides/database-schema.md).
- Never send `BEGIN` / `COMMIT` yourself and never call Drizzle's `db.transaction()`. Use `dbAdapter.transaction()` or `dbStorage.transaction()`.
- A `resolveConflict` function must not query the database. It runs inside a transaction and would deadlock.
- In React, list the props and state that the `query` passed to `useLiveQuery` reads in its `deps` option (like `useEffect` dependencies). `query` itself need not be stable; without `deps`, a changed value is only used on the next change of the watched collections.
- Only one tab (the **leader**) syncs. `client.role` tells you which one this is; this is expected, not a bug.
- The authoritative type definitions live in `packages/*/src`. When a doc and the source disagree, trust the source and fix the doc.
