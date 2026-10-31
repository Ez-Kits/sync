# `@ez-kits/sync-client-typeorm-adapter`

DB adapter for [TypeORM](https://typeorm.io) `^0.3.28`. It creates a TypeORM `DataSource` whose driver runs every statement on a DB storage.

```bash
npm install @ez-kits/sync-client-typeorm-adapter typeorm reflect-metadata
```

Enable `experimentalDecorators` and `emitDecoratorMetadata` in `tsconfig.json`, and `import "reflect-metadata"` once before your entities.

| Entry point                                   | Contents                                                    |
| --------------------------------------------- | ----------------------------------------------------------- |
| `@ez-kits/sync-client-typeorm-adapter`        | `defineTypeOrmCollection`, types, low-level building blocks |
| `@ez-kits/sync-client-typeorm-adapter/sqlite` | `createTypeOrmSqliteDBAdapter` (for sql.js and SQLite WASM) |
| `@ez-kits/sync-client-typeorm-adapter/pg`     | `createTypeOrmPgDBAdapter` (for PGlite)                     |

---

## `defineTypeOrmCollection(options)`

```ts
import "reflect-metadata";
import { Column, Entity, PrimaryColumn } from "typeorm";
import { defineTypeOrmCollection } from "@ez-kits/sync-client-typeorm-adapter";

@Entity("todos")
export class Todo {
  @PrimaryColumn("text") id!: string;
  @Column("text") title!: string;
  @Column("boolean", { default: false }) completed!: boolean;
  @Column("integer") updatedAt!: number;
}

export const todosCollection = defineTypeOrmCollection({
  name: "todos",
  entity: Todo,
  primaryField: "id",
});
```

| Option         | Type             | Required | Description                                                                       |
| -------------- | ---------------- | -------- | --------------------------------------------------------------------------------- |
| `name`         | `string` literal | yes      | The collection name.                                                              |
| `entity`       | an entity class  | yes      | A class decorated with `@Entity`.                                                 |
| `primaryField` | a property name  | yes      | Must be the entity's primary column, or the call throws `Primary field mismatch`. |
| `syncAdapter`  | `SyncAdapter`    | no       | A sync adapter for this collection only.                                          |

Models: `insert` takes `DeepPartial<Todo>`, `update` takes `Partial<Todo>` (with the primary key), `get` returns `Todo`.

---

## `createTypeOrmSqliteDBAdapter(config)`

```ts
import { createTypeOrmSqliteDBAdapter } from "@ez-kits/sync-client-typeorm-adapter/sqlite";

const dbAdapter = createTypeOrmSqliteDBAdapter({ dbStorage, collections: [todosCollection] });
```

For `sqlite` storages. Creates a TypeORM `expo`-type data source with a driver that runs on the storage (you do not need Expo).

## `createTypeOrmPgDBAdapter(config)`

```ts
import { createTypeOrmPgDBAdapter } from "@ez-kits/sync-client-typeorm-adapter/pg";

const dbAdapter = createTypeOrmPgDBAdapter({ dbStorage, collections: [todosCollection] });
```

For `postgres` storages. Creates a `postgres` data source whose `pg` driver runs on the storage (you do not need the `pg` package). `installExtensions` defaults to `false`.

### Config (both dialects)

| Option              | Type                           | Required | Description                                                                                                  |
| ------------------- | ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------ |
| `dbStorage`         | `DBStorage`                    | yes      | Must match the adapter's dialect, or the call throws.                                                        |
| `collections`       | collection array               | yes      | The same collections you pass to the sync client.                                                            |
| `entities`          | `(Function \| EntitySchema)[]` | no       | Other entities the data source must know, for example targets of relations that are not collections.         |
| `dataSourceOptions` | TypeORM data source options    | no       | `logging`, `namingStrategy`, ... `type`, `driver` and `entities` are set for you (and `database` on SQLite). |

The data source is opened by the local-change store's `initialize()`, which the sync client calls. Do not call `db.initialize()` yourself.

### The returned adapter

`TypeOrmDBAdapter` implements [`BaseDBAdapter`](client-core.md#db-adapter-contract), plus:

| Member            | Description                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db`              | The TypeORM `DataSource`, with `db.repositories.<collection>`: a typed `Repository` per collection. Same as `queryBuilder`. Use it for **reads**. |
| `schema`          | `{ [collectionName]: entityClass }`. Same as `querySchema`.                                                                                       |
| `transaction(fn)` | Run `fn(tx, context)` in one transaction. `context.native` is the TypeORM `EntityManager` of the transaction.                                     |
| others            | See [the contract](client-core.md#db-adapter-contract).                                                                                           |

```ts
client.liveQuery({
  collections: ["todos"],
  query: (db) =>
    db.repositories.todos.find({ where: { completed: false }, order: { updatedAt: "DESC" } }),
  onData: render,
});
```

Rules:

- **Read** with `db`; **write** through `client.collections`.
- The adapter's own transactions run on a **second** data source over the same storage, so application queries never see uncommitted sync data. `db.destroy()` closes both.
- Create your tables with SQL migrations in the storage worker. Do not use `synchronize: true`. See [Your database schema](../guides/database-schema.md).

---

## Outbox entities

| Export                      | Entry point | Description                                          |
| --------------------------- | ----------- | ---------------------------------------------------- |
| `sqliteLocalChangeEntities` | `/sqlite`   | `EntitySchema`s of the `ez_sync_*` tables on SQLite. |
| `pgLocalChangeEntities`     | `/pg`       | The same on Postgres.                                |

They are registered and created by the adapter. Read them for debugging only.

## Low-level building blocks

| Export                                                                                                                                                                                                                                                                                                                                                                | Description                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createTypeOrmProxyDBAdapter(config, driver)`                                                                                                                                                                                                                                                                                                                         | The dialect-independent adapter. `driver` is a `TypeOrmProxyDriver`: `{ dialect, createDataSource(dbStorage, entities, options), localChangeEntities }`. |
| `createTypeOrmSqliteDriver(dbStorage)` (`/sqlite`)                                                                                                                                                                                                                                                                                                                    | The SQLite driver object TypeORM's `expo` data source runs on.                                                                                           |
| `createTypeOrmPgDriver(dbStorage)` (`/pg`)                                                                                                                                                                                                                                                                                                                            | The `pg`-compatible module TypeORM's `postgres` data source runs on.                                                                                     |
| `buildSchemaFromCollections(collections)`                                                                                                                                                                                                                                                                                                                             | `{ [name]: entity }`                                                                                                                                     |
| `TypeOrmDBAdapter`, `TypeOrmDatabase`, `TypeOrmRepositories`, `TypeOrmQueryResult`, `TypeOrmCollectionConfig`, `DefineTypeOrmCollectionOptions`, `EntityClass`, `BuildSchemaFromCollections`, `TypeOrmEntity`, `TypeOrmProxyDBAdapterConfig`, `TypeOrmProxyDriver`, `TypeOrmLocalChangeEntities`, `TypeOrmEventRow`, `TypeOrmAppliedEventRow`, `TypeOrmCheckpointRow` | Types.                                                                                                                                                   |
| `TypeOrmSqliteDBAdapterConfig`, `TypeOrmSqliteDataSourceOptions` (`/sqlite`), `TypeOrmPgDBAdapterConfig`, `TypeOrmPgDataSourceOptions` (`/pg`)                                                                                                                                                                                                                        | Config types of the dialect adapters.                                                                                                                    |
