# @ez-kits/sync-client-typeorm-adapter

TypeORM adapter for EzSync. It bridges a `DBStorage` (sql.js, SQLite WASM, PGlite, ...) to TypeORM: it creates the `DataSource` itself, with a driver that runs every statement on the storage, and provides collection CRUD, a typed data source for live queries, transactional application of pulled remote changes, and the outbox. It supports scalar and composite primary keys when the collection configuration and entity metadata agree.

```ts
import { createDBCheckpointStorage, createSyncClient } from "@ez-kits/sync-client-core";
import { defineTypeormCollection } from "@ez-kits/sync-client-typeorm-adapter";
import { createTypeOrmSqliteDBAdapter } from "@ez-kits/sync-client-typeorm-adapter/sqlite";
import { createSqlJsStorage } from "@ez-kits/sync-storage-sqljs";

const dbStorage = createSqlJsStorage({
  key: "todos",
  engineOptions: { indexedDB: "todos-sqljs" },
  worker: () => new Worker(new URL("./db-worker.ts", import.meta.url), { type: "module" }),
});

const collections = [defineTypeormCollection({ name: "todos", entity: Todo, primaryField: "id" })];
const dbAdapter = createTypeOrmSqliteDBAdapter({ dbStorage, collections });
// Checkpoints in the database, saved in the transaction of the rows they describe.
const checkpointStorage = createDBCheckpointStorage({
  localChangeStore: dbAdapter.localChangeStore,
  serializer: JSON.stringify,
  deserializer: JSON.parse,
});

const client = createSyncClient({ collections, dbAdapter, checkpointStorage });

client.liveQuery({
  collections: ["todos"],
  query: (db) => db.repositories.todos.find({ where: { completed: false } }),
  onData: (todos) => render(todos),
});
```

## Entry points

Each dialect has its own entry point with its own storage driver:

| Entry point                                   | Adapter                        | Storages            | Data source                                                                              |
| --------------------------------------------- | ------------------------------ | ------------------- | ---------------------------------------------------------------------------------------- |
| `@ez-kits/sync-client-typeorm-adapter/sqlite` | `createTypeOrmSqliteDBAdapter` | sql.js, SQLite WASM | `expo` type, driver from `createTypeOrmSqliteDriver`                                     |
| `@ez-kits/sync-client-typeorm-adapter/pg`     | `createTypeOrmPgDBAdapter`     | PGlite              | `postgres` type, `pg` module from `createTypeOrmPgDriver`                                |
| `@ez-kits/sync-client-typeorm-adapter`        | —                              | —                   | Shared, dialect-free API: `defineTypeormCollection`, `buildSchemaFromCollections`, types |

The driver runs every statement on the storage, so the data source works the same in the leader tab and in followers. TypeORM's `BEGIN`/`START TRANSACTION`, `COMMIT` and `ROLLBACK` open and end a `dbStorage.transaction`, so a follower's transaction runs isolated on the leader; savepoints stay inside it. On SQLite, TypeORM shares one query runner per data source, so statements sent while a transaction of `db` is open join it, as on one SQLite connection. The adapter's own transactions (`transaction`, `commitLocalMutation`, and so applying pulled changes) run on a second data source on the same storage, so live queries and other statements on `db` wait for them and never see their uncommitted writes. `db.destroy()` closes that data source too, and the next adapter transaction opens it again. An adapter throws when the storage speaks another dialect. Both adapters are built on `createTypeOrmProxyDBAdapter`, which takes a small driver (`dialect`, `createDataSource`, `localChangeEntities`).

Options:

- `entities`: other entities the data source should know, such as targets of relations. Collection entities are registered for you.
- `dataSourceOptions`: other TypeORM options (`logging`, `namingStrategy`, `synchronize`, ...). The type, driver and entities are set by the adapter.

## Typed data source

`dbAdapter.queryBuilder` (the first argument of `liveQuery`) is the adapter's `DataSource`, with a typed repository per collection: `db.repositories.todos` is a `Repository<Todo>`. The second argument maps collection names to entity classes, so `db.getRepository(schema.todos)` is typed too.

The data source opens when the sync client initializes the local-change store, before its first query. Use `dbAdapter.db` for anything else you need from TypeORM.

## Outbox entities

The outbox and dirty records live in predefined entities, `ez_sync_events` and `ez_sync_dirty_records` (`sqliteLocalChangeEntities` from `./sqlite`, `pgLocalChangeEntities` from `./pg`). Pending events are read in the order of `seq`, a generated primary key the database assigns on insert (`TypeOrmEventRow`), so they follow commit order; event `id`s stay unique. The adapter registers the entities on its data source and creates their tables itself: its local-change store's `initialize()` builds them from the entity metadata in one transaction and records the schema version in `ez_sync_meta`. Tables an older version created (without `seq`) are rebuilt in that transaction, numbering the pending events in their old `createdAt, id` order. A third entity, `ez_sync_applied_events` (`TypeOrmAppliedEventRow`), records the `id` of every appended event in the same transaction and keeps it after the event is acknowledged, so a retried local mutation can tell it already landed (`hasAppliedEvent`). Records older than `APPLIED_EVENT_RETENTION_MS` (24 hours), counted back from the newest appended event, are pruned as events are appended. Schema version 3 adds it: `initialize()` creates it in databases of version 2. Two more entities keep the sync state that must live and die with the rows: `ez_sync_checkpoints` (`TypeOrmCheckpointRow`) holds the serialized checkpoints of `createDBCheckpointStorage` (recommended over localStorage: they are saved in the pull transaction, and lost with the database), and `ez_sync_skipped_remote_events` (`SkippedRemoteEvent`) holds, per record, the latest pulled event skipped because the record had pending writes, as JSON, until the acknowledgement that applies it. Schema version 4 adds them: `initialize()` creates them in databases of version 3. Switching an existing app to the DB checkpoint storage makes the next pull start without a checkpoint, once. The sync client calls it before anything touches the database. Declare and migrate only your own entities.

`dbAdapter.transaction((tx, { native }) => ...)` passes the transaction's entity manager as `native`; give it to the local-change store to read or write the outbox in the same transaction.

The row, outbox event, and dirty record of a local mutation commit together or are rolled back together.

## Reads

`get` rejects when a record is missing. `getOptional` returns `undefined` for a missing record and still rejects on database errors, so the sync engine can tell absence from a failed query.

## Development

```bash
pnpm --filter @ez-kits/sync-client-typeorm-adapter build
pnpm --filter @ez-kits/sync-client-typeorm-adapter test
```
