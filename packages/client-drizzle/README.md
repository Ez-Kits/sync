# @ez-kits/sync-client-drizzle-adapter

Drizzle ORM adapter for EzSync. It bridges a `DBStorage` (sql.js, SQLite WASM, PGlite, ...) to Drizzle: collection CRUD, a type-safe Drizzle database for live queries, transactional application of pulled remote changes, and the outbox. It supports scalar and composite primary keys when the collection configuration and Drizzle schema agree.

```ts
import { createSyncClient } from "@ez-kits/sync-client-core";
import { createDrizzleSqliteDBAdapter } from "@ez-kits/sync-client-drizzle-adapter/sqlite";
import { createSqlJsStorage } from "@ez-kits/sync-storage-sqljs";

const dbStorage = createSqlJsStorage({
  key: "todos",
  engineOptions: { indexedDB: "todos-sqljs" },
  worker: () => new Worker(new URL("./db-worker.ts", import.meta.url), { type: "module" }),
});

const dbAdapter = createDrizzleSqliteDBAdapter({ dbStorage, collections });

const client = createSyncClient({ collections, dbAdapter, checkpointStorage });

client.liveQuery({
  collections: ["todos"],
  query: (db) => db.query.todos.findMany({ where: { completed: false } }),
  onData: (todos) => render(todos),
});
```

## Entry points

Each dialect has its own entry point, so an app bundles only the Drizzle driver it uses:

| Entry point                                   | Adapter                        | Storages            | Query builder                                                                               |
| --------------------------------------------- | ------------------------------ | ------------------- | ------------------------------------------------------------------------------------------- |
| `@ez-kits/sync-client-drizzle-adapter/sqlite` | `createDrizzleSqliteDBAdapter` | sql.js, SQLite WASM | `SqliteRemoteDatabase` (`drizzle-orm/sqlite-proxy`)                                         |
| `@ez-kits/sync-client-drizzle-adapter/pg`     | `createDrizzlePgDBAdapter`     | PGlite              | `PgRemoteDatabase` (`drizzle-orm/pg-proxy`)                                                 |
| `@ez-kits/sync-client-drizzle-adapter`        | —                              | —                   | Shared, dialect-free API: `defineDrizzleCollection`, `buildRelationsFromCollections`, types |

The proxy driver runs every statement on the storage, so the query builder works the same in the leader tab and in followers. An adapter throws when the storage speaks another dialect. Both adapters are built on `createDrizzleProxyDBAdapter`, which takes a small driver (`dialect`, `createDatabase`, `createLocalChangeStore`) if you need another proxy driver.

Pass `drizzleConfig` for other Drizzle options (`logger`, `casing`, `codecs`, ...). Column values are decoded with Drizzle's sql.js (SQLite) and PGlite (Postgres) codecs unless you pass `codecs`.

## Relations

The relational query API (`db.query.<table>`) uses `relations`. By default the adapter calls `buildRelationsFromCollections(collections)`, which registers every collection table without relations between them. Pass your own `defineRelations(...)` result to add relations or other tables:

```ts
const relations = defineRelations({ todos, notes }, (r) => ({
  todos: { notes: r.many.notes({ from: r.todos.id, to: r.notes.todoId }) },
}));

createDrizzleSqliteDBAdapter({ dbStorage, collections, relations });
```

## Outbox tables

The outbox and dirty records live in predefined tables, `ez_sync_events` and `ez_sync_dirty_records` (`sqliteLocalChangeTables` from `./sqlite`, `pgLocalChangeTables` from `./pg`). Pending events are read in the order of `seq`, a key the database assigns on insert (`INTEGER PRIMARY KEY AUTOINCREMENT` on SQLite, a `BIGINT` identity on Postgres), so they follow commit order; event `id`s stay unique. A custom events table for `createDrizzleLocalChangeStore` needs such a `seq` column too.

The adapter creates the tables itself: its local-change store's `initialize()` creates them in one storage transaction and records the schema version in `ez_sync_meta`. Tables an older version created (without `seq`) are rebuilt in that transaction, numbering the pending events in their old `createdAt, id` order. The sync client calls it before anything touches the database. Keep only your own tables in your migrations.

The row, outbox event, and dirty record of a local mutation commit together or are rolled back together.

## Transactions

`dbAdapter.transaction`, local mutations, and pulled changes get a Drizzle database bound to one `dbStorage.transaction`, so a follower's transaction runs isolated on the leader. `dbAdapter.transaction((tx, { native }) => ...)` passes that database as `native`; give it to the local-change store to read or write the outbox in the same transaction. Queries through `queryBuilder` or the adapter itself wait until the transaction ends, so do not await them inside it. Do not call `queryBuilder.transaction()`: the proxy drivers would send a bare `BEGIN`, which the storage rejects.

## Development

```bash
pnpm --filter @ez-kits/sync-client-drizzle-adapter build
pnpm --filter @ez-kits/sync-client-drizzle-adapter test
```
