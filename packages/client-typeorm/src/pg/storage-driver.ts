import type { DBExecutor, DBStorage } from "@ez-kits/sync-client-core";
import { StorageSession, statementKind } from "../core/storage-session";

/** What TypeORM's `postgres` driver reads from one executed statement (a `pg` result). */
export interface TypeOrmPgQueryResult {
  rows: unknown[];
  rowCount: number;
  command: string;
}

/** A `pg` client as TypeORM's `postgres` driver uses it. */
export interface TypeOrmPgConnection {
  query(sql: string, params?: unknown[]): Promise<TypeOrmPgQueryResult>;
  on(event: string, listener: (...args: unknown[]) => void): TypeOrmPgConnection;
  removeListener(event: string, listener: (...args: unknown[]) => void): TypeOrmPgConnection;
}

type ConnectCallback = (
  error: Error | undefined,
  connection: TypeOrmPgConnection,
  release: () => void,
) => void;

/** A `pg` pool as TypeORM's `postgres` driver uses it. */
export interface TypeOrmPgPool {
  connect(callback: ConnectCallback): void;
  on(event: string, listener: (...args: unknown[]) => void): TypeOrmPgPool;
  end(callback?: (error?: Error) => void): void;
}

/** The module passed as the `driver` option of a `postgres` data source (in place of `pg`). */
export interface TypeOrmPgDriver {
  Pool: new (options?: unknown) => TypeOrmPgPool;
}

const NO_ROWS = (command: string): TypeOrmPgQueryResult => ({ rows: [], rowCount: 0, command });

async function run(
  executor: DBExecutor,
  sql: string,
  params: unknown[],
  command: string,
  write: boolean,
) {
  const { rows, affectedRows } = await executor.exec({
    sql,
    params,
    method: "all",
    rowMode: "object",
  });
  // Like `pg`: reads count the rows they return, writes the rows they changed.
  return { rows, rowCount: write ? (affectedRows ?? rows.length) : rows.length, command };
}

/** One pooled client; each TypeORM query runner holds its own, with its own transaction. */
function createConnection(dbStorage: DBStorage): TypeOrmPgConnection & { release(): void } {
  const session = new StorageSession(dbStorage);

  async function query(sql: string, params: unknown[] = []): Promise<TypeOrmPgQueryResult> {
    const kind = statementKind(sql);
    const command = sql.trimStart().split(/\s+/, 1)[0]!.toUpperCase();
    if (kind === "begin") {
      session.begin();
      return NO_ROWS("BEGIN");
    }
    if (kind === "commit" || kind === "rollback") {
      await session.end(kind === "commit");
      return NO_ROWS(command);
    }
    const write = kind === "write";
    if (session.inTransaction) return run(await session.transaction(), sql, params, command, write);
    if (!write) return run(dbStorage, sql, params, command, false);
    // A write outside a transaction commits on its own, so it is durable once it resolves.
    return dbStorage.transaction((tx) => run(tx, sql, params, command, true));
  }

  const connection = {
    query,
    on: () => connection,
    removeListener: () => connection,
    // A client returned to the pool mid-transaction (a failed runner) rolls it back.
    release: () => void session.end(false),
  };
  return connection;
}

/**
 * A `pg`-compatible module over a Postgres {@link DBStorage}, for the `driver` option of a
 * TypeORM `postgres` data source. Every statement runs on the storage, so a follower tab's
 * queries and transactions run on the leader's database. `createTypeOrmPgDBAdapter` builds
 * its data source with it.
 *
 * Each pooled client tracks its own transaction: `START TRANSACTION`/`COMMIT`/`ROLLBACK`
 * open and end a `dbStorage.transaction` that the client's statements join. Writes outside
 * a transaction run in one of their own, so they are durable once they resolve.
 */
export function createTypeOrmPgDriver(dbStorage: DBStorage): TypeOrmPgDriver {
  if (dbStorage.dialect !== "postgres") {
    throw new Error(
      `The TypeORM Postgres driver needs a postgres storage, not ${dbStorage.dialect}.`,
    );
  }
  class Pool implements TypeOrmPgPool {
    connect(callback: ConnectCallback): void {
      const connection = createConnection(dbStorage);
      callback(undefined, connection, () => connection.release());
    }
    on(): TypeOrmPgPool {
      return this;
    }
    // The storage belongs to the application; closing the data source leaves it open.
    end(callback?: (error?: Error) => void): void {
      callback?.();
    }
  }
  return { Pool };
}
