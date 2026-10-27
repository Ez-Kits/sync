import type { SqliteProxyExecutors } from "drizzle-orm/sqlite-proxy";

/** One `drizzle-orm/sqlite-proxy` call, serialized for the storage owner. */
export type SqliteProxyRequest =
  | { method: "all" | "get"; sql: string; params: unknown[]; rowMode?: "array" | "object" }
  | { method: "run"; sql: string; params: unknown[] };

/**
 * Follower side: `sqlite-proxy` executors that forward every statement to the owner.
 * Pass them to `drizzle()` with the same schema/relations as the owner's database.
 */
export function forwardSqliteProxy(
  send: (request: SqliteProxyRequest) => Promise<unknown>,
): SqliteProxyExecutors {
  return {
    all: ((sql: string, params: unknown[], rowMode?: "array" | "object") =>
      send({ method: "all", sql, params, rowMode })) as SqliteProxyExecutors["all"],
    get: ((sql: string, params: unknown[], rowMode?: "array" | "object") =>
      send({ method: "get", sql, params, rowMode })) as SqliteProxyExecutors["get"],
    run: (sql: string, params: unknown[]) => send({ method: "run", sql, params }),
  };
}

/** Owner side: run a forwarded statement with the owner's own `sqlite-proxy` executors. */
export function executeSqliteProxyRequest(
  executors: SqliteProxyExecutors,
  request: SqliteProxyRequest,
): Promise<unknown> {
  if (request.method === "run") return executors.run(request.sql, request.params);
  return executors[request.method](request.sql, request.params, request.rowMode);
}
