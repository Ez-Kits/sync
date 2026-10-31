# EzSync

EzSync is a modular, local-first sync library for TypeScript applications. Your app reads and writes a real SQL database in the browser, so it works offline and responds instantly. EzSync records every local change, pushes it to your backend when it can, and pulls remote changes back in, across every open tab.

You pick each piece separately: the local database engine, the ORM you query it with, and the backend you sync to. The core depends on none of them.

## Why EzSync

- **Local-first.** Collections live in SQLite (sql.js or the official SQLite WASM build) or Postgres (PGlite), persisted in the browser. Reads and live queries never wait for the network.
- **Writes are never lost.** Each local write commits together with its outbox entry in one transaction. Nothing leaves the outbox until the backend has accepted it, or until your app explicitly discards a write the backend refused.
- **Many tabs, one database.** Tabs elect a leader that holds the database and runs sync; the other tabs forward their queries to it. Live queries refresh in every tab.
- **Resumable pulls.** Pull checkpoints are stored in the same database as the rows and saved in the same transaction, so a failed or interrupted pull resumes without skipping changes.
- **Explicit conflict handling.** When a remote change meets a record with unpushed local writes, a resolver you choose decides the outcome, and the outbox is updated to match.
- **Refused writes don't block sync.** A write the backend refuses (for example under security rules) is set aside and retried later, while every other write keeps syncing.

## How it fits together

```
your app ── collections, live queries
   │
sync client ─────────────► sync adapter ──► your backend (Firestore, Realtime Database, ...)
   │
DB adapter (Drizzle, TypeORM)
   │
DB storage ── leader election across tabs
   │
engine (sql.js, SQLite WASM, PGlite)
```

```ts
const dbStorage = createSqlJsStorage({ key: "todos", worker: () => new Worker(workerUrl) });
const dbAdapter = createDrizzleSqliteDBAdapter({ dbStorage, collections });
const client = createSyncClient({ collections, dbAdapter, syncAdapter });

client.startSync();
```

## Packages

| Package                                | Role                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `@ez-kits/sync-client-core`            | Sync client runtime and the contracts every other package implements      |
| `@ez-kits/sync-client-drizzle-adapter` | DB adapter for Drizzle ORM (SQLite and Postgres entry points)             |
| `@ez-kits/sync-client-typeorm-adapter` | DB adapter for TypeORM (SQLite and Postgres entry points)                 |
| `@ez-kits/sync-client-react`           | React bindings: provider, `useSyncClient`, `useLiveQuery`                 |
| `@ez-kits/sync-storage-sqljs`          | SQLite (sql.js) in a worker, snapshotted to IndexedDB                     |
| `@ez-kits/sync-storage-sqlite-wasm`    | Official SQLite WASM in a worker, persisted to OPFS (no COOP/COEP needed) |
| `@ez-kits/sync-storage-pglite`         | Postgres (PGlite) in a worker, persisted to IndexedDB                     |
| `@ez-kits/sync-firebase`               | Sync adapters for Cloud Firestore and the Firebase Realtime Database      |
| `@ez-kits/sync-conflict-resolution`    | Ready-made conflict policies: last write wins, field merge, and others    |

A typical app installs the core, one DB adapter, one storage engine and one sync adapter. Your app configures authentication and security rules for its backend; EzSync does not manage them.

## Learn more

- [Documentation](docs/README.md): installation, a step-by-step quick start, guides, the API reference of every package, and how to write your own DB storage, DB adapter or sync adapter.
- [Architecture decisions](https://github.com/Ez-Kits/sync/blob/main/architecture.md): why EzSync works the way it does, and its guarantees and trade-offs.
- [Examples](https://github.com/Ez-Kits/sync/tree/main/examples): todo apps with React, Drizzle or TypeORM, and Firestore.

## Status

EzSync is approaching a stable API but is not there yet; expect breaking changes between releases.

## Development

This repository uses [Vite+](https://viteplus.dev) (`vp`) with pnpm workspaces.

```bash
vp install         # install dependencies
vp check           # format, lint and type check
vp test            # run the tests
vp run build -r    # build every package
```

## License

[MIT](https://github.com/Ez-Kits/sync/blob/main/LICENSE)
