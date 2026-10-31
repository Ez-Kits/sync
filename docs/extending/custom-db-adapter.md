# Custom DB adapter

A **DB adapter** connects a DB storage to a way of querying it: an ORM (Drizzle, TypeORM) or plain SQL. Write one to use another ORM (Kysely, MikroORM, ...) or none at all.

An adapter has four jobs:

| Job                        | What it means                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------ |
| **Collections**            | A `define...Collection` helper that describes a collection's table for your adapter. |
| **CRUD**                   | `insert`, `update`, `delete`, `get`, `getOptional`, `getMany` by collection name.    |
| **Transactions**           | `transaction(fn)` and `commitLocalMutation(...)`, on `dbStorage.transaction`.        |
| **The local-change store** | The outbox and sync state, in tables of the same database. The biggest part.         |

Plus `queryBuilder` and `querySchema`, which live queries receive, and an optional `close()`: the client's `dispose()` calls it after sync stops and before it closes `dbStorage`, so an adapter that opens something of its own (an ORM data source) can release it. Leave `dbStorage` to the client.

This page builds a complete, working adapter for **plain SQL on SQLite**, about 300 lines. It is a good template for any ORM: replace the SQL strings with your ORM's calls.

## The rules

Read these first; each one protects a guarantee.

1. **One storage, one dialect.** Every statement runs on `config.dbStorage`. Throw if `dbStorage.dialect` is not the dialect you generate SQL for.
2. **Never send `BEGIN` / `COMMIT`.** Open transactions with `dbStorage.transaction((tx) => ...)`. If your ORM manages transactions itself, map them onto `dbStorage.transaction` (the TypeORM adapter does this) or do not use that feature.
3. **Inside a transaction, use only its executor `tx`.** A statement sent on `dbStorage` while a transaction is open waits for that transaction to end: awaiting it inside the transaction deadlocks until the timeout.
4. **`commitLocalMutation` is atomic.** Run `mutate`, `persistOutboxEvent` and `persistDirtyRecord` in **one** transaction, in that order, and pass each the same context.
5. **The context's `native` is your transaction handle.** The store's methods receive it as `transactionContext` and must then run on that transaction. For plain SQL it is the `tx` executor; for Drizzle, a Drizzle database bound to `tx`; for TypeORM, an `EntityManager`.
6. **`getOptional` returns `undefined` only when the row is missing.** A failed query must reject, never look like "missing". `get` rejects when the row is missing. Sync decisions depend on this.
7. **`update` is partial.** It receives the primary key plus only the changed fields. Leave other columns untouched.
8. **The store owns its schema.** `initialize()` creates the store's tables when missing (and upgrades them in later versions). It must be idempotent and safe to run from several tabs at once: do it in one `dbStorage.transaction`.
9. **Outbox order comes from the database.** Give events an auto-increment `seq` assigned on insert, and read pending events `ORDER BY seq`. Never order by `createdAt`.
10. **Applied events outlive acknowledgement.** `appendEvents` records each event id in an applied-events table in the same transaction; `deleteEvents` does not remove them. Prune records older than `APPLIED_EVENT_RETENTION_MS` before the newest appended event.

## Step 1: collections

A collection config is a plain object: `{ name, adapterConfig, primaryField, syncAdapter? }`. `adapterConfig` holds whatever your adapter needs; here, a table name and its columns. The type parameters carry the row types to `client.collections`.

```ts
// sql-adapter/collection.ts
import type { CollectionConfig } from "@ez-kits/sync-client-core";

export interface SqlTableConfig {
  table: string;
  columns: readonly string[];
}

export type SqlCollectionConfig<TName extends string, Row, PK extends keyof Row> = CollectionConfig<
  TName,
  SqlTableConfig, // adapterConfig
  Partial<Row>, // what update() accepts
  Row, // what insert() accepts
  Row, // what get() returns
  PK
>;

/**
 * defineSqlCollection<Todo>()({ name: "todos", table: "todos", columns: [...], primaryField: "id" })
 * The first call fixes the row type; the second infers the rest.
 */
export function defineSqlCollection<Row extends Record<string, unknown>>() {
  return <TName extends string, PK extends keyof Row & string>(options: {
    name: TName;
    table: string;
    columns: readonly (keyof Row & string)[];
    primaryField: PK;
  }): SqlCollectionConfig<TName, Row, PK> => ({
    name: options.name,
    adapterConfig: { table: options.table, columns: options.columns },
    primaryField: options.primaryField,
  });
}
```

## Step 2: the query builder

Live queries call `query(adapter.queryBuilder, adapter.querySchema)`. For an ORM, `queryBuilder` is the ORM's database object. For plain SQL, a tiny helper:

```ts
// sql-adapter/query-builder.ts
import type { DBExecutor } from "@ez-kits/sync-client-core";

export interface SqlQueryBuilder {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export function queryBuilderFor(executor: DBExecutor): SqlQueryBuilder {
  return {
    async all<T>(sql: string, params: unknown[] = []) {
      const { rows } = await executor.exec({ sql, params, method: "all", rowMode: "object" });
      return rows as T[];
    },
  };
}
```

## Step 3: CRUD

CRUD runs on an **executor**: the storage itself, or a transaction's `tx`. Building the operations from an executor lets you reuse them inside transactions.

```ts
// sql-adapter/operations.ts
import type {
  CollectionConfigMap,
  DBAdapterOperations,
  DBExecutor,
} from "@ez-kits/sync-client-core";
import type { SqlTableConfig } from "./collection";

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

export function createOperations<C extends CollectionConfigMap>(
  executor: DBExecutor,
  collections: C,
): DBAdapterOperations<C> {
  const configOf = (name: string) => {
    const config = collections.find((collection) => collection.name === name);
    if (!config) throw new Error(`Unknown collection: ${name}`);
    const { table, columns } = config.adapterConfig as SqlTableConfig;
    return { table: quote(table), columns, primaryField: String(config.primaryField) };
  };
  /** The fields of `data` that are columns, in a stable order. */
  const fieldsOf = (columns: readonly string[], data: unknown) =>
    columns.filter((column) => (data as Record<string, unknown>)[column] !== undefined);

  const getOptional = async (collection: string, id: unknown) => {
    const { table, primaryField } = configOf(collection);
    const { rows } = await executor.exec({
      sql: `SELECT * FROM ${table} WHERE ${quote(primaryField)} = ?`,
      params: [id],
      method: "get",
      rowMode: "object",
    });
    return rows[0]; // undefined only when there is no row; a failed query has rejected already
  };

  const operations = {
    async insert(collection: string, data: unknown) {
      const { table, columns } = configOf(collection);
      const fields = fieldsOf(columns, data);
      await executor.exec({
        sql: `INSERT INTO ${table} (${fields.map(quote).join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`,
        params: fields.map((field) => (data as Record<string, unknown>)[field]),
        method: "run",
      });
    },
    async update(collection: string, data: unknown) {
      const { table, columns, primaryField } = configOf(collection);
      const id = (data as Record<string, unknown>)[primaryField];
      if (id === undefined) throw new Error(`Update requires primary field "${primaryField}"`);
      const fields = fieldsOf(columns, data).filter((field) => field !== primaryField);
      if (fields.length === 0) return;
      await executor.exec({
        sql: `UPDATE ${table} SET ${fields.map((field) => `${quote(field)} = ?`).join(", ")} WHERE ${quote(primaryField)} = ?`,
        params: [...fields.map((field) => (data as Record<string, unknown>)[field]), id],
        method: "run",
      });
    },
    async delete(collection: string, id: unknown) {
      const { table, primaryField } = configOf(collection);
      await executor.exec({
        sql: `DELETE FROM ${table} WHERE ${quote(primaryField)} = ?`,
        params: [id],
        method: "run",
      });
    },
    getOptional,
    async get(collection: string, id: unknown) {
      const row = await getOptional(collection, id);
      if (row === undefined)
        throw new Error(`Row not found in "${collection}" for id ${String(id)}`);
      return row;
    },
    async getMany(collection: string) {
      const { table } = configOf(collection);
      const { rows } = await executor.exec({
        sql: `SELECT * FROM ${table}`,
        params: [],
        method: "all",
        rowMode: "object",
      });
      return rows;
    },
  };
  // The methods are typed by collection name in DBAdapterOperations; the runtime is the same.
  return operations as unknown as DBAdapterOperations<C>;
}
```

Pulled changes are applied through these operations too: EzSync calls `getOptional`, then `update` if the row exists or `insert` if not, and `delete` for deletes.

## Step 4: the local-change store

The store keeps the outbox and the sync state in five tables. Every method takes an optional `transactionContext` (your `native` handle): with it, run on that transaction; without it, run on the storage.

```ts
// sql-adapter/local-change-store.ts
import {
  APPLIED_EVENT_RETENTION_MS,
  type AtomicLocalChangeStore,
  type DBExecutor,
  type DBStorage,
  type DirtyRecord,
  type LocalChangeScope,
  type SkippedRemoteEvent,
  type StoredChangeBusEvent,
} from "@ez-kits/sync-client-core";

// Your own table names: do not reuse ez_sync_*, which another adapter may have created
// with a different layout.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_sync_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  collection TEXT NOT NULL,
  data TEXT,
  recordId TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS app_sync_events_record ON app_sync_events (collection, recordId);
CREATE TABLE IF NOT EXISTS app_sync_dirty_records (
  collection TEXT NOT NULL,
  recordId TEXT NOT NULL,
  state TEXT NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (collection, recordId)
);
CREATE TABLE IF NOT EXISTS app_sync_applied_events (
  eventId TEXT PRIMARY KEY NOT NULL,
  appliedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_sync_checkpoints (
  collection TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_sync_skipped_remote_events (
  collection TEXT NOT NULL,
  recordId TEXT NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY (collection, recordId)
);`;

/** WHERE clause for everything, one collection, or one record of a collection. */
function scopeWhere(scope: LocalChangeScope | undefined): { where: string; params: unknown[] } {
  if (scope === undefined) return { where: "", params: [] };
  if (typeof scope === "string") return { where: "WHERE collection = ?", params: [scope] };
  return {
    where: "WHERE collection = ? AND recordId = ?",
    params: [scope.collection, scope.recordId],
  };
}

export function createSqlLocalChangeStore(dbStorage: DBStorage): AtomicLocalChangeStore {
  // Rule 5: with a transaction context, run in that transaction.
  const on = (transactionContext?: unknown) =>
    (transactionContext as DBExecutor | undefined) ?? dbStorage;
  const run = (tx: unknown, sql: string, params: unknown[] = []) =>
    on(tx).exec({ sql, params, method: "run" });
  const all = async <T>(tx: unknown, sql: string, params: unknown[] = []) =>
    (await on(tx).exec({ sql, params, method: "all", rowMode: "object" })).rows as T[];

  return {
    // Tells the sync client that local mutations are atomic with the outbox.
    atomicLocalMutationCapability: "atomic",

    // Rule 8: idempotent, in one transaction. A later version would read a schema version
    // here and run upgrade steps.
    async initialize() {
      await dbStorage.transaction((tx) => tx.exec({ sql: SCHEMA, params: [], method: "run" }));
    },

    async appendEvents(events: StoredChangeBusEvent[], tx) {
      if (events.length === 0) return;
      for (const event of events) {
        // Rule 9: `seq` is left out, so the database assigns it.
        await run(
          tx,
          "INSERT INTO app_sync_events (id, type, collection, data, recordId, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
          [
            event.id,
            event.type,
            event.collection,
            event.data == null ? null : JSON.stringify(event.data),
            event.recordId,
            event.createdAt,
          ],
        );
      }
      // Rule 10: record the ids as applied, and prune old records.
      const newest = Math.max(...events.map((event) => event.createdAt));
      await run(tx, "DELETE FROM app_sync_applied_events WHERE appliedAt < ?", [
        newest - APPLIED_EVENT_RETENTION_MS,
      ]);
      for (const event of events) {
        await run(
          tx,
          "INSERT OR REPLACE INTO app_sync_applied_events (eventId, appliedAt) VALUES (?, ?)",
          [event.id, event.createdAt],
        );
      }
    },
    async hasAppliedEvent(eventId, tx) {
      const rows = await all(tx, "SELECT 1 FROM app_sync_applied_events WHERE eventId = ?", [
        eventId,
      ]);
      return rows.length > 0;
    },
    async getPendingEvents(scope, tx) {
      const { where, params } = scopeWhere(scope);
      const rows = await all<StoredChangeBusEvent & { data: string | null }>(
        tx,
        `SELECT id, type, collection, data, recordId, createdAt FROM app_sync_events ${where} ORDER BY seq`,
        params,
      );
      return rows.map((row) => ({ ...row, data: row.data === null ? null : JSON.parse(row.data) }));
    },
    async deleteEvents(ids, tx) {
      if (ids.length === 0) return;
      await run(
        tx,
        `DELETE FROM app_sync_events WHERE id IN (${ids.map(() => "?").join(", ")})`,
        ids,
      );
    },
    async upsertDirtyRecord(record: DirtyRecord, tx) {
      await run(
        tx,
        `INSERT INTO app_sync_dirty_records (collection, recordId, state, updatedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT (collection, recordId) DO UPDATE SET state = excluded.state, updatedAt = excluded.updatedAt`,
        [record.collection, record.recordId, record.state, record.updatedAt],
      );
    },
    async removeDirtyRecords(keys, tx) {
      for (const key of keys) {
        await run(tx, "DELETE FROM app_sync_dirty_records WHERE collection = ? AND recordId = ?", [
          key.collection,
          key.recordId,
        ]);
      }
    },
    async getDirtyRecords(scope, tx) {
      const { where, params } = scopeWhere(scope);
      return all<DirtyRecord>(
        tx,
        `SELECT collection, recordId, state, updatedAt FROM app_sync_dirty_records ${where}`,
        params,
      );
    },
    async getCheckpoint(collection, tx) {
      const rows = await all<{ value: string }>(
        tx,
        "SELECT value FROM app_sync_checkpoints WHERE collection = ?",
        [collection],
      );
      return rows[0]?.value;
    },
    async saveCheckpoint(collection, value, tx) {
      if (value === undefined) {
        await run(tx, "DELETE FROM app_sync_checkpoints WHERE collection = ?", [collection]);
        return;
      }
      await run(
        tx,
        `INSERT INTO app_sync_checkpoints (collection, value) VALUES (?, ?)
         ON CONFLICT (collection) DO UPDATE SET value = excluded.value`,
        [collection, value],
      );
    },
    async getSkippedRemoteEvents(scope, tx) {
      const { where, params } = scopeWhere(scope);
      const rows = await all<{ collection: string; recordId: string; event: string }>(
        tx,
        `SELECT collection, recordId, event FROM app_sync_skipped_remote_events ${where}`,
        params,
      );
      return rows.map((row): SkippedRemoteEvent => ({ ...row, event: JSON.parse(row.event) }));
    },
    async upsertSkippedRemoteEvent(entry, tx) {
      await run(
        tx,
        `INSERT INTO app_sync_skipped_remote_events (collection, recordId, event) VALUES (?, ?, ?)
         ON CONFLICT (collection, recordId) DO UPDATE SET event = excluded.event`,
        [entry.collection, entry.recordId, JSON.stringify(entry.event)],
      );
    },
    async removeSkippedRemoteEvents(keys, tx) {
      for (const key of keys) {
        await run(
          tx,
          "DELETE FROM app_sync_skipped_remote_events WHERE collection = ? AND recordId = ?",
          [key.collection, key.recordId],
        );
      }
    },
  };
}
```

What each table is for:

| Table                            | Written by                                                  | Read by                                                                   |
| -------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| `app_sync_events` (the outbox)   | `appendEvents` on every local write                         | `getPendingEvents` before each push; `deleteEvents` after acknowledgement |
| `app_sync_dirty_records`         | `upsertDirtyRecord` on every local write                    | conflict detection on pull                                                |
| `app_sync_applied_events`        | `appendEvents`                                              | `hasAppliedEvent` when a write is retried after a leader change           |
| `app_sync_checkpoints`           | `saveCheckpoint` with each pulled batch                     | `getCheckpoint` when a pull starts                                        |
| `app_sync_skipped_remote_events` | `upsertSkippedRemoteEvent` on a `"local"` conflict decision | applied when the record's last local write is acknowledged                |

## Step 5: the adapter

Put it together. `transaction` and `commitLocalMutation` share one helper that opens a storage transaction and builds the context.

```ts
// sql-adapter/index.ts
import type {
  BaseDBAdapter,
  CollectionConfigMap,
  CollectionNames,
  DBAdapterOperations,
  DBAdapterTransactionContext,
  DBExecutor,
  DBStorage,
} from "@ez-kits/sync-client-core";
import type { SqlTableConfig } from "./collection";
import { createSqlLocalChangeStore } from "./local-change-store";
import { createOperations } from "./operations";
import { queryBuilderFor, type SqlQueryBuilder } from "./query-builder";

export { defineSqlCollection } from "./collection";

/** What live queries receive as `schema`: the table name of each collection. */
export type SqlSchema<C extends CollectionConfigMap> = Record<CollectionNames<C>, string>;

export function createSqlDBAdapter<C extends CollectionConfigMap>(config: {
  dbStorage: DBStorage;
  collections: C;
}): BaseDBAdapter<C, SqlQueryBuilder, SqlSchema<C>> {
  const { dbStorage, collections } = config;
  // Rule 1.
  if (dbStorage.dialect !== "sqlite") {
    throw new Error(`This adapter speaks sqlite, but the storage speaks ${dbStorage.dialect}.`);
  }
  const schema = Object.fromEntries(
    collections.map((collection) => [
      collection.name,
      (collection.adapterConfig as SqlTableConfig).table,
    ]),
  ) as SqlSchema<C>;

  // Rules 2, 3 and 5: one storage transaction; everything inside goes through `tx`.
  const inTransaction = <T>(
    fn: (operations: DBAdapterOperations<C>, context: DBAdapterTransactionContext<C>) => Promise<T>,
  ) =>
    dbStorage.transaction((tx: DBExecutor) => {
      const operations = createOperations(tx, collections);
      return fn(operations, { operations, native: tx });
    });

  return {
    queryBuilder: queryBuilderFor(dbStorage),
    querySchema: schema,
    dbStorage,
    localChangeStore: createSqlLocalChangeStore(dbStorage),
    ...createOperations(dbStorage, collections),
    transaction: (fn) => inTransaction(fn),
    // Rule 4: the three steps of a local write, atomically and in order.
    commitLocalMutation: ({ mutate, persistOutboxEvent, persistDirtyRecord }) =>
      inTransaction(async (_operations, context) => {
        await mutate(context);
        await persistOutboxEvent(context);
        await persistDirtyRecord(context);
      }),
  };
}
```

## Use it

```ts
import { createSyncClient } from "@ez-kits/sync-client-core";
import { createSqlDBAdapter, defineSqlCollection } from "./sql-adapter";

interface Todo extends Record<string, unknown> {
  id: string;
  title: string;
  completed: number; // SQLite has no booleans
  updatedAt: number;
}

const todosCollection = defineSqlCollection<Todo>()({
  name: "todos",
  table: "todos",
  columns: ["id", "title", "completed", "updatedAt"],
  primaryField: "id",
});

const dbAdapter = createSqlDBAdapter({ dbStorage, collections: [todosCollection] });
const client = createSyncClient({ collections: [todosCollection], dbAdapter, syncAdapter });

await client.collections.todos.insert({
  id: "1",
  title: "Hello",
  completed: 0,
  updatedAt: Date.now(),
});

client.liveQuery({
  collections: ["todos"],
  query: (db) =>
    db.all<Todo>("SELECT * FROM todos WHERE completed = ? ORDER BY updatedAt DESC", [0]),
  onData: render,
});
```

The app still creates the `todos` table itself, in the storage worker (see [Your database schema](../guides/database-schema.md)).

## Making it production-ready

The example is complete but minimal. For a published adapter, also:

- **Version the schema.** Keep a version in a meta table; in `initialize()`, read it and run upgrade steps from each earlier version in the same transaction. Users never migrate your tables.
- **Convert values.** Decode column types on read (SQLite `0/1` to booleans, JSON text to objects) so `get` returns the same shape the app inserted.
- **Support Postgres** with `$1` placeholders, `BIGINT GENERATED ALWAYS AS IDENTITY` for `seq`, `JSONB` for data, and `ON CONFLICT ... DO UPDATE`.
- **Batch statements** in `appendEvents`, `deleteEvents` and `remove*` for speed.

## Reusing the Drizzle building blocks

If your ORM is Drizzle with another driver, or you want Drizzle's outbox store, reuse the pieces the Drizzle adapter is made of:

- `createDrizzleProxyDBAdapter(config, driver)` builds the adapter from a `DrizzleProxyDriver`: `{ dialect, createDatabase(executor, relations), createLocalChangeStore(db, dbStorage) }`.
- `createDrizzleLocalChangeStore({ db, tables, initialize })` is the outbox store on any five Drizzle tables with the expected columns.

See `packages/client-drizzle/src/sqlite/index.ts` for how the SQLite adapter wires them, and the [Drizzle adapter reference](../api/client-drizzle-adapter.md#low-level-building-blocks).

## Checklist

- [ ] `createSyncClient` accepts the adapter (it checks `dbStorage`, `commitLocalMutation`, and `localChangeStore.atomicLocalMutationCapability === "atomic"` with `initialize`).
- [ ] `initialize()` can run twice, and from two clients at once, without errors.
- [ ] After `insert`, `getPendingEvents()` returns the event, and `hasAppliedEvent(id)` is `true`.
- [ ] A throw inside `commitLocalMutation`'s `persistDirtyRecord` leaves **no** row and **no** outbox event.
- [ ] `getOptional` returns `undefined` for a missing row and rejects when the table is missing.
- [ ] `update` with only some fields keeps the others.
- [ ] A full round trip works with a [fake sync adapter](custom-sync-adapter.md#a-fake-adapter-for-tests): local insert is pushed; a pulled change appears in `getMany`.
