# Your database schema

There are two kinds of tables in the local database:

| Tables                    | Who creates and upgrades them |
| ------------------------- | ----------------------------- |
| `ez_sync_*` (outbox, ...) | **EzSync**, automatically     |
| Your collection tables    | **You**                       |

The ORM definitions (a Drizzle table, a TypeORM entity) tell the ORM what the table looks like. They do **not** create it. You create it with SQL.

## Where to run migrations

Run your migrations in the **storage worker**, inside the function you pass to `startDBStorageWorker`. That function runs only in the leader's worker, right after the engine opens and before any query from any tab.

```ts
// src/db/worker.ts
import { startDBStorageWorker } from "@ez-kits/sync-client-core";
import { openSqlJsEngine, type SqlJsEngineOptions } from "@ez-kits/sync-storage-sqljs/worker";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { migrate } from "./migrations";

startDBStorageWorker<SqlJsEngineOptions>(async (options) => {
  const engine = await openSqlJsEngine({ ...options, wasmUrl });
  try {
    await migrate(engine);
  } catch (error) {
    await engine.close(); // release the database so the next attempt can open it
    throw error;
  }
  return engine;
});
```

`engine` is a `DBExecutor`: it has one method, `exec({ sql, params, method })`.

- `method: "run"` runs a statement and returns no rows.
- `method: "all"` returns all rows (as arrays by default; add `rowMode: "object"` for objects).
- `method: "get"` returns only the first row.

## Write migrations that can run many times

The worker runs `open` again every time a tab becomes leader: on each visit, and when the leader tab closes and another takes over. Make every migration **safe to run twice**:

- `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`.
- Before `ALTER TABLE ... ADD COLUMN`, check that the column is missing.

A simple pattern with a version number (SQLite):

```ts
// src/db/migrations.ts
import type { DBExecutor } from "@ez-kits/sync-client-core";

const run = (sql: string) => ({ sql, params: [], method: "run" as const });

const steps: string[] = [
  // version 1
  `CREATE TABLE IF NOT EXISTS todos (
     id TEXT PRIMARY KEY NOT NULL,
     title TEXT NOT NULL,
     completed INTEGER NOT NULL DEFAULT 0,
     updatedAt INTEGER NOT NULL
   )`,
  // version 2
  `ALTER TABLE todos ADD COLUMN projectId TEXT`,
];

export async function migrate(db: DBExecutor): Promise<void> {
  const { rows } = await db.exec({ sql: "PRAGMA user_version", params: [], method: "all" });
  const current = Number((rows[0] as unknown[] | undefined)?.[0] ?? 0);
  for (let version = current; version < steps.length; version += 1) {
    await db.exec(run(steps[version]!));
    await db.exec(run(`PRAGMA user_version = ${version + 1}`));
  }
}
```

On Postgres (PGlite) keep the version in a small table of your own instead of `PRAGMA user_version`, or use `ADD COLUMN IF NOT EXISTS`.

> **Do not name your tables `ez_sync_*`.** That prefix belongs to EzSync.

### Using drizzle-kit to write the SQL

You can generate the SQL from your Drizzle schema with [drizzle-kit](https://orm.drizzle.team/docs/kit-overview) (`drizzle-kit generate`) and paste or import the generated statements into your migration steps. EzSync does not run drizzle-kit for you.

### TypeORM

Write the `CREATE TABLE` statements the same way. Do not rely on TypeORM's `synchronize: true`; it is not designed to run from several tabs and workers.

## Columns and types to keep in mind

- **Booleans** in SQLite are `INTEGER` (0 or 1). Drizzle's `integer({ mode: "boolean" })` and TypeORM's `boolean` columns convert for you.
- **Timestamps**: store numbers (`Date.now()`), as `INTEGER` in SQLite or `BIGINT` in Postgres. They are easy to compare and to sync.
- **JSON**: SQLite stores it as `TEXT` (Drizzle `text({ mode: "json" })`), Postgres as `JSONB`.
- The data you sync is exactly the row. Columns that are local only (for example a UI flag) are pushed too. Leave them out in the sync adapter's `serializeCreate` / `serializeUpdate` if the backend should not see them.

## Starting over

To wipe the local database (for example on sign-out), delete it from browser storage after calling `await client.dispose()` in every tab:

- sql.js: delete the IndexedDB database named in `engineOptions.indexedDB`.
- PGlite: delete the IndexedDB database of `dataDir` (`idb://name` uses `/pglite/name`).
- SQLite WASM: remove the file from the OPFS pool, or use a new `filename`.

Using a new storage `key` and database name per user is often simpler. Checkpoints live in the database too, so a fresh database starts a full pull.

## Next

- [Choosing a storage engine](storage-engines.md)
