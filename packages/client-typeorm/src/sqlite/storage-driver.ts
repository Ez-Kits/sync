import type { DBExecutor, DBStorage } from "@ez-kits/sync-client-core";
import { StorageSession, statementKind } from "../core/storage-session";

/** What TypeORM's `expo` driver reads from one executed statement. */
export interface TypeOrmSqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowId: number;
  getAllAsync(): Promise<unknown[]>;
}

/** The database handle TypeORM's `expo` driver opens. */
export interface TypeOrmSqliteConnection {
  runAsync(sql: string, ...params: unknown[]): Promise<TypeOrmSqliteRunResult>;
  prepareAsync(sql: string): Promise<{
    executeAsync(params?: unknown[]): Promise<TypeOrmSqliteRunResult>;
    finalizeAsync(): Promise<void>;
  }>;
  closeAsync(): Promise<void>;
}

/** The module passed as the `driver` option of an `expo` data source. */
export interface TypeOrmSqliteDriver {
  openDatabaseAsync(database: string): Promise<TypeOrmSqliteConnection>;
}

const NO_ROWS: TypeOrmSqliteRunResult = {
  changes: 0,
  lastInsertRowId: 0,
  getAllAsync: async () => [],
};

async function run(
  executor: DBExecutor,
  sql: string,
  params: unknown[],
  write: boolean,
): Promise<TypeOrmSqliteRunResult> {
  const { rows } = await executor.exec({ sql, params, method: "all", rowMode: "object" });
  let changes = 0;
  let lastInsertRowId = 0;
  if (write) {
    const info = await executor.exec({
      sql: "SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowId",
      params: [],
      method: "get",
      rowMode: "object",
    });
    ({ changes, lastInsertRowId } = info.rows[0] as { changes: number; lastInsertRowId: number });
  }
  return { changes, lastInsertRowId, getAllAsync: async () => rows };
}

function createConnection(dbStorage: DBStorage): TypeOrmSqliteConnection {
  const session = new StorageSession(dbStorage);

  async function execute(sql: string, params: unknown[]): Promise<TypeOrmSqliteRunResult> {
    const kind = statementKind(sql);
    if (kind === "begin") {
      session.begin();
      return NO_ROWS;
    }
    if (kind === "commit" || kind === "rollback") {
      await session.end(kind === "commit");
      return NO_ROWS;
    }
    const write = kind === "write";
    if (session.inTransaction) return run(await session.transaction(), sql, params, write);
    if (!write) return run(dbStorage, sql, params, false);
    // The commit makes the write durable, and `changes()` reads this statement's count.
    return dbStorage.transaction((tx) => run(tx, sql, params, true));
  }

  return {
    runAsync: (sql, ...params) => execute(sql, params),
    prepareAsync: async (sql) => ({
      executeAsync: (params = []) => execute(sql, params),
      finalizeAsync: async () => {},
    }),
    // The storage belongs to the application; only an open transaction is ended.
    closeAsync: () => session.end(false),
  };
}

/**
 * A TypeORM `expo` driver over a SQLite {@link DBStorage}. Every statement runs on the
 * storage, so a follower tab's TypeORM queries and transactions run on the leader's
 * database. `createTypeOrmSqliteDBAdapter` builds its data source with it.
 *
 * TypeORM's `BEGIN`/`COMMIT`/`ROLLBACK` open and end a `dbStorage.transaction`, and like
 * one SQLite connection, statements sent while it is open join it (TypeORM shares one
 * query runner per data source, so the adapter opens its transactions on a second one).
 * Writes outside a transaction run in one of their own, so they are durable once they resolve.
 */
export function createTypeOrmSqliteDriver(dbStorage: DBStorage): TypeOrmSqliteDriver {
  if (dbStorage.dialect !== "sqlite") {
    throw new Error(`The TypeORM SQLite driver needs a sqlite storage, not ${dbStorage.dialect}.`);
  }
  return {
    openDatabaseAsync: async () => createConnection(dbStorage),
  };
}
