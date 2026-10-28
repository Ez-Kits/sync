# @ez-kits/sync-client-typeorm-adapter

TypeORM adapter for EzSync. It bridges a `DBStorage` (sql.js, SQLite WASM, PGlite, ...) to TypeORM: it creates the `DataSource` itself, with a driver that runs every statement on the storage, and provides collection CRUD, a typed data source for live queries, transactional application of pulled remote changes, and the outbox. It supports scalar and composite primary keys when the collection configuration and entity metadata agree.

```ts
import { createSyncClient } from "@ez-kits/sync-client-core";
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

The driver runs every statement on the storage, so the data source works the same in the leader tab and in followers. TypeORM's `BEGIN`/`START TRANSACTION`, `COMMIT` and `ROLLBACK` open and end a `dbStorage.transaction`, so a follower's transaction runs isolated on the leader; savepoints stay inside it. An adapter throws when the storage speaks another dialect. Both adapters are built on `createTypeOrmProxyDBAdapter`, which takes a small driver (`dialect`, `createDataSource`, `localChangeEntities`).

Options:

- `entities`: other entities the data source should know, such as targets of relations. Collection entities are registered for you.
- `dataSourceOptions`: other TypeORM options (`logging`, `namingStrategy`, `synchronize`, ...). The type, driver and entities are set by the adapter.

## Typed data source

`dbAdapter.queryBuilder` (the first argument of `liveQuery`) is the adapter's `DataSource`, with a typed repository per collection: `db.repositories.todos` is a `Repository<Todo>`. The second argument maps collection names to entity classes, so `db.getRepository(schema.todos)` is typed too.

The data source opens when the sync client initializes the local-change store, before its first query. Use `dbAdapter.db` for anything else you need from TypeORM.

## Outbox entities

The outbox and dirty records live in predefined entities, `ez_sync_events` and `ez_sync_dirty_records` (`sqliteLocalChangeEntities` from `./sqlite`, `pgLocalChangeEntities` from `./pg`). The adapter registers them on its data source and creates their tables itself: its local-change store's `initialize()` builds them from the entity metadata, and the sync client calls it before anything touches the database. Declare and migrate only your own entities.

The row, outbox event, and dirty record of a local mutation commit together or are rolled back together.

## Reads

`get` rejects when a record is missing. `getOptional` returns `undefined` for a missing record and still rejects on database errors, so the sync engine can tell absence from a failed query.

## Development

```bash
pnpm --filter @ez-kits/sync-client-typeorm-adapter build
pnpm --filter @ez-kits/sync-client-typeorm-adapter test
```
