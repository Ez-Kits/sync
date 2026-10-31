# `@ez-kits/sync-client-drizzle-adapter`

DB adapter for [Drizzle ORM](https://orm.drizzle.team) **1.0** (`drizzle-orm@1.0.0-rc.5`). It runs Drizzle on a DB storage through Drizzle's proxy drivers, so the same code works in every tab.

```bash
npm install @ez-kits/sync-client-drizzle-adapter drizzle-orm@1.0.0-rc.5
```

| Entry point                                   | Contents                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `@ez-kits/sync-client-drizzle-adapter`        | `defineDrizzleCollection`, schema helpers, types, low-level building blocks |
| `@ez-kits/sync-client-drizzle-adapter/sqlite` | `createDrizzleSqliteDBAdapter` (for sql.js and SQLite WASM)                 |
| `@ez-kits/sync-client-drizzle-adapter/pg`     | `createDrizzlePgDBAdapter` (for PGlite)                                     |

Import the adapter from the entry point of your dialect, so your bundle includes only that Drizzle driver.

---

## `defineDrizzleCollection(options)`

```ts
import { defineDrizzleCollection } from "@ez-kits/sync-client-drizzle-adapter";

const todosCollection = defineDrizzleCollection({ name: "todos", table: todos });
```

| Option         | Type              | Required | Description                                                                                      |
| -------------- | ----------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `name`         | `string` literal  | yes      | The collection name (`client.collections.<name>`).                                               |
| `table`        | a Drizzle `Table` | yes      | `sqliteTable(...)` or `pgTable(...)`.                                                            |
| `primaryField` | a column key      | no       | Defaults to the table's primary key column. Throws `Primary field not found` when there is none. |
| `syncAdapter`  | `SyncAdapter`     | no       | A sync adapter for this collection only.                                                         |

Models are inferred from the table: `insert` takes `InferInsertModel<table>`, `update` takes `Partial<InferInsertModel<table>>` (with the primary key), `get` returns `InferSelectModel<table>`.

**Checkpoint type.** To type the collection's pull checkpoint, pass all type parameters:

```ts
defineDrizzleCollection<"todos", typeof todos, "id", Todo, TodoCheckpoint>({
  name: "todos",
  table: todos,
});
```

The order is: name, table, primary field, select model, checkpoint.

---

## `createDrizzleSqliteDBAdapter(config)`

```ts
import { createDrizzleSqliteDBAdapter } from "@ez-kits/sync-client-drizzle-adapter/sqlite";

const dbAdapter = createDrizzleSqliteDBAdapter({ dbStorage, collections: [todosCollection] });
```

For storages with `dialect: "sqlite"` (sql.js, SQLite WASM). Uses `drizzle-orm/sqlite-proxy`.

## `createDrizzlePgDBAdapter(config)`

```ts
import { createDrizzlePgDBAdapter } from "@ez-kits/sync-client-drizzle-adapter/pg";

const dbAdapter = createDrizzlePgDBAdapter({ dbStorage, collections: [todosCollection] });
```

For storages with `dialect: "postgres"` (PGlite). Uses `drizzle-orm/pg-proxy`. Define tables with `pgTable`.

### Config (both dialects)

| Option          | Type                                  | Required | Description                                                                                                         |
| --------------- | ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `dbStorage`     | `DBStorage`                           | yes      | Must match the adapter's dialect, or the call throws.                                                               |
| `collections`   | collection tuple                      | yes      | The same collections you pass to the sync client.                                                                   |
| `relations`     | result of Drizzle's `defineRelations` | no       | Relations for `db.query`. Default: every collection table, without relations.                                       |
| `drizzleConfig` | Drizzle options except `relations`    | no       | `logger`, `casing`, `codecs`, ... `codecs` default to Drizzle's sql.js codecs (SQLite) or PGlite codecs (Postgres). |

### The returned adapter

`DrizzleDBAdapter` implements [`BaseDBAdapter`](client-core.md#db-adapter-contract), plus:

| Member                                                                                                                | Description                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `db`                                                                                                                  | The Drizzle database (`SqliteRemoteDatabase` / `PgRemoteDatabase`). Same as `queryBuilder`. Use it for **reads**.  |
| `schema`                                                                                                              | `{ [collectionName]: table }`. Same as `querySchema`.                                                              |
| `transaction(fn)`                                                                                                     | Run `fn(tx, context)` in one storage transaction. `context.native` is a Drizzle database bound to the transaction. |
| `dbStorage`, `localChangeStore`, `insert`, `update`, `delete`, `get`, `getOptional`, `getMany`, `commitLocalMutation` | See [the contract](client-core.md#db-adapter-contract).                                                            |

Rules:

- **Read** with `db`; **write** through `client.collections`. Writes made with `db` are not synced.
- Do not call Drizzle's `db.transaction()`: it sends `BEGIN`, which the storage rejects. Use `dbAdapter.transaction()`.
- Use a single-column primary key. The outbox identifies records by the primary key turned into a string. Composite keys are not supported: an object id passed to `get`, `getOptional` or `delete` throws a `TypeError`.

### Relations

To query relations with `with`, build them with `defineRelations` and pass them in:

```ts
import { defineRelations } from "drizzle-orm";

const relations = defineRelations({ projects, todos }, (r) => ({
  projects: { todos: r.many.todos({ from: r.projects.id, to: r.todos.projectId }) },
  todos: { project: r.one.projects({ from: r.todos.projectId, to: r.projects.id }) },
}));

const dbAdapter = createDrizzleSqliteDBAdapter({
  dbStorage,
  collections: [projectsCollection, todosCollection],
  relations,
});

client.liveQuery({
  collections: ["projects", "todos"],
  query: (db) => db.query.projects.findMany({ with: { todos: true } }),
  onData: render,
});
```

The schema passed to `defineRelations` may also contain tables that are not collections (read-only lookup tables, for example).

---

## Outbox tables

The adapter creates and upgrades its own tables on `initialize()`. You never migrate them.

| Export                    | Entry point | Description                                              |
| ------------------------- | ----------- | -------------------------------------------------------- |
| `sqliteLocalChangeTables` | `/sqlite`   | Drizzle definitions of the `ez_sync_*` tables on SQLite. |
| `pgLocalChangeTables`     | `/pg`       | The same on Postgres.                                    |

You may read them for debugging (for example, counting pending events: `db.select().from(sqliteLocalChangeTables.events)`), but never write to them.

---

## Helpers

| Export                                       | Description                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `buildSchemaFromCollections(collections)`    | `{ [name]: table }`                                                                  |
| `buildRelationsFromCollections(collections)` | `defineRelations(buildSchemaFromCollections(collections))`: the default `relations`. |
| `sqliteProxyExecutors(executor)` (`/sqlite`) | `drizzle-orm/sqlite-proxy` executors that run on a `DBExecutor`.                     |

## Low-level building blocks

For writing an adapter for another Drizzle driver. See [Custom DB adapter](../extending/custom-db-adapter.md#reusing-the-drizzle-building-blocks).

| Export                                                                                                                                                                                                                                                                            | Description                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createDrizzleProxyDBAdapter(config, driver)`                                                                                                                                                                                                                                     | The dialect-independent adapter. `driver` is a `DrizzleProxyDriver`: `{ dialect, createDatabase(executor, relations), createLocalChangeStore(db, dbStorage) }`. |
| `createDrizzleLocalChangeStore({ db, tables, initialize })`                                                                                                                                                                                                                       | An `AtomicLocalChangeStore` on five Drizzle tables.                                                                                                             |
| `DrizzleProxyDBAdapterConfig`, `DrizzleProxyDriver`, `DrizzleDBAdapter`, `DrizzleLocalChangeStoreConfig`, `DrizzleLocalChangeStoreTables`, `DrizzleEventTable`, `DrizzleDirtyRecordTable`, `DrizzleAppliedEventTable`, `DrizzleCheckpointTable`, `DrizzleSkippedRemoteEventTable` | Their types.                                                                                                                                                    |
| `DrizzleCollectionConfig`, `DefineDrizzleCollectionOptions`, `BuildSchemaFromCollections`, `BuildRelationsFromCollections`, `InferPrimaryField`, `DrizzleQueryResult`                                                                                                             | Collection and schema types.                                                                                                                                    |
| `DrizzleSqliteDBAdapterConfig`, `DrizzleSqliteOptions` (`/sqlite`), `DrizzlePgDBAdapterConfig`, `DrizzlePgOptions` (`/pg`)                                                                                                                                                        | Config types of the dialect adapters.                                                                                                                           |
