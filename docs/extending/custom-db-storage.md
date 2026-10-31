# Custom DB storage

Want to run EzSync on a database engine it does not ship with, such as `node:sqlite`, wa-sqlite or a native SQLite in Electron? You almost never need to write a whole `DBStorage`. Write a small **DB engine** instead, and let EzSync's built-in storage handle transactions, tabs and leader election for you.

| You write... | EzSync gives you...                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| A `DBEngine` | `createLocalDBStorage` (this context) or `createWorkerDBStorage` + `startDBStorageWorker` (shared by tabs) |

## The `DBEngine` contract

```ts
import type { DBEngine, DBQuery, DBQueryResult } from "@ez-kits/sync-client-core";

interface DBEngine {
  exec(query: DBQuery): Promise<DBQueryResult>;
  flush?(): Promise<void>;
  close(): Promise<void>;
}
```

### `exec(query)`

`query` is `{ sql, params, method, rowMode? }`. Your engine must:

1. **Bind `params` positionally.** SQLite statements use `?`, Postgres statements use `$1, $2, ...`. Turn `undefined` into `NULL`. If your engine has no boolean type (SQLite), turn `true` / `false` into `1` / `0`.
2. **Handle `method`:**
   - `"run"`: run the statement, return `{ rows: [] }`. Optionally report `affectedRows`.
   - `"all"`: return every row.
   - `"get"`: return at most the first row (`rows` with zero or one entry).
3. **Shape rows by `rowMode`:** `"array"` (the default when missing) returns each row as an array of column values **in select order**; `"object"` returns `{ column: value }` objects. Keep arrays as arrays: a join can return two columns with the same name.
4. **Run several statements** when `method` is `"run"` and `params` is empty. The SQL may be a script like `CREATE TABLE ...; CREATE INDEX ...;`. EzSync's own table setup sends such scripts.
5. **Accept `BEGIN`, `COMMIT` and `ROLLBACK`** as plain `run` statements. The storage sends them to the engine itself; your engine just executes them.
6. **Reject on errors.** Never return an empty result for a failed query.

You do not need to make `exec` safe for concurrent calls or to serialize transactions: the storage calls the engine one statement at a time, and runs one transaction at a time.

### `flush()` (optional)

Make committed data durable. The storage calls it after every `COMMIT` and after every `run` outside a transaction. Engines that persist on their own (a file on disk, OPFS, PGlite's IndexedDB) leave it out. sql.js uses it to save its snapshot.

### `close()`

Release everything: file handles, locks, workers. In the browser, the **next leader** opens the same database right after the old one closes, so a handle left open blocks it.

## Example: `node:sqlite` in Node.js

Node 24+ ships a SQLite engine, `node:sqlite`. This engine wraps it:

```ts
// node-sqlite-engine.ts
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { DBEngine, DBQuery, DBQueryResult } from "@ez-kits/sync-client-core";

function toSqlite(value: unknown): SQLInputValue {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as SQLInputValue;
}

export function openNodeSqliteEngine(path = ":memory:"): DBEngine {
  const db = new DatabaseSync(path);

  return {
    async exec(query: DBQuery): Promise<DBQueryResult> {
      // Rule 4: a parameterless "run" may be a multi-statement script.
      if (query.method === "run" && query.params.length === 0) {
        db.exec(query.sql);
        return { rows: [] };
      }
      const statement = db.prepare(query.sql);
      const params = query.params.map(toSqlite);
      if (query.method === "run") {
        const { changes } = statement.run(...params);
        return { rows: [], affectedRows: Number(changes) };
      }
      // Rule 3: arrays by default, objects on request.
      statement.setReturnArrays(query.rowMode !== "object");
      const rows = statement.all(...params);
      return { rows: query.method === "get" ? rows.slice(0, 1) : rows };
    },
    async close() {
      db.close();
    },
  };
}
```

Use it with `createLocalDBStorage`, and everything else is unchanged:

```ts
import { createLocalDBStorage, createSyncClient } from "@ez-kits/sync-client-core";
import { createDrizzleSqliteDBAdapter } from "@ez-kits/sync-client-drizzle-adapter/sqlite";
import { openNodeSqliteEngine } from "./node-sqlite-engine";
import { migrate } from "./migrations";

const dbStorage = createLocalDBStorage({
  dialect: "sqlite",
  open: async () => {
    const engine = openNodeSqliteEngine("./app.db");
    await migrate(engine);
    return engine;
  },
});

const dbAdapter = createDrizzleSqliteDBAdapter({ dbStorage, collections: [todosCollection] });
const client = createSyncClient({ collections: [todosCollection], dbAdapter });
```

## Example: a browser engine shared by every tab

To share an engine between tabs, run it in a worker with `startDBStorageWorker`, and start that worker with `createWorkerDBStorage`. This is exactly how the built-in storages are made.

**1. The engine and its worker side.**

```ts
// my-storage/worker.ts (what users import in their worker module)
import type { DBEngine } from "@ez-kits/sync-client-core";

/** Plain data only: these options travel from the page to the worker. */
export interface MyEngineOptions {
  filename: string;
}

export async function openMyEngine(options: MyEngineOptions): Promise<DBEngine> {
  const db = await openSomeWasmDatabase(options.filename); // your engine
  return {
    exec: async (query) => runQuery(db, query), // follow the six rules above
    close: async () => db.close(),
  };
}
```

**2. The page side.**

```ts
// my-storage/index.ts (what users import on the page)
import {
  createWorkerDBStorage,
  type DBStorage,
  type WorkerDBStorageOptions,
} from "@ez-kits/sync-client-core";
import type { MyEngineOptions } from "./worker";

export type MyStorageOptions = Omit<WorkerDBStorageOptions<MyEngineOptions>, "dialect">;

export function createMyStorage(options: MyStorageOptions): DBStorage {
  return createWorkerDBStorage({ ...options, dialect: "sqlite" });
}
```

**3. How an app uses it** (the same pattern as every built-in engine):

```ts
// app: db/worker.ts
import { startDBStorageWorker } from "@ez-kits/sync-client-core";
import { openMyEngine, type MyEngineOptions } from "my-storage/worker";

startDBStorageWorker<MyEngineOptions>(async (options, { signal }) => {
  const engine = await openMyEngine(options);
  // `signal` aborts when this worker stops leading; useful for long-running opens.
  await migrate(engine);
  return engine;
});
```

```ts
// app: db/storage.ts
import { createMyStorage } from "my-storage";

export const dbStorage = createMyStorage({
  key: "my-app",
  engineOptions: { filename: "/my-app.db" },
  worker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
});
```

What you get for free:

- Only the leader's worker calls `open`. When the leader goes away, another worker calls it.
- Followers' statements and transactions are forwarded to the leader.
- Transactions are serialized and rolled back after `transactionTimeoutMs` of inactivity, or when the tab that opened them dies.
- Statements outside a transaction wait for the open one to end.
- `BEGIN` / `COMMIT` sent by users are rejected with `TransactionStatementError`.

Your engine needs **no** multi-tab support of its own. It only has to tolerate being closed in one worker and opened in another.

## Implementing `DBStorage` directly

Only do this if the built-in coordination does not fit, for example an engine that is already shared by every context (a database in a `SharedWorker` you control, or a server-side database). Even then, `createLocalDBStorage({ dialect, open })` around your engine is often enough, since it adds the transaction scheduling for you.

If you do implement it, every rule of the [`DBStorage` interface](../api/client-core.md#dbstorage) applies:

- `dialect`, `key` and `role` (`"leader"` when this context may sync).
- `ready` resolves once queries can run, and rejects if they never will.
- `transaction(fn)` runs everything sent through its `tx` in one transaction, commits when `fn` resolves, rolls back when it throws. Only one transaction runs at a time across **all** contexts sharing the database.
- `exec` outside a transaction **waits** for an open transaction to end. It never joins it.
- `exec` rejects transaction-control statements with `TransactionStatementError` (use `isTransactionControl(sql)`).
- Idle transactions are rolled back after a timeout (`TransactionClosedError` for later statements).
- `onRoleChange`, `onInvalidate` (call it when changes may have been missed, such as after a leader change) and `onError` return unsubscribe functions.
- When a write's outcome is unknown (the holder of the database went away mid-request), reject with an error that has `retriable: true` (`LeaderChangedError`). The sync client then checks whether the write landed before retrying it.
- `close()` releases everything; later calls reject with `DBStorageClosedError`.

## Checklist

Before shipping an engine, check that:

- [ ] `SELECT v FROM t` with `method: "all"` returns rows as arrays (`[["a"], ["b"]]`), and with `rowMode: "object"` as objects (`[{ v: "a" }, { v: "b" }]`).
- [ ] `run` returns `{ rows: [] }`, and `method: "get"` returns at most one row (none when nothing matches).
- [ ] A parameterless multi-statement `run` script works.
- [ ] `BEGIN` / `COMMIT` / `ROLLBACK` work, and a rolled-back insert is gone.
- [ ] `undefined` parameters are stored as `NULL`.
- [ ] Data survives `close()` and reopening (if the engine persists).
- [ ] A full client works on it: create a sync client with the Drizzle adapter, insert, read back, `dispose()`.

The built-in engines test these cases in `packages/storage-*/tests/contract.test.ts`; copy them for your engine.
