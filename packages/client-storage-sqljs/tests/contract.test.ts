import { createLocalDBStorage, type DBQuery } from "@ez-kits/sync-client-core";
import { IDBFactory } from "fake-indexeddb";
import { expect, test, vi } from "vite-plus/test";
import { createSqlJsDBStorage } from "../src";
import { openSqlJsEngine } from "../src/worker";

const run = (sql: string, params: unknown[] = []): DBQuery => ({ sql, params, method: "run" });
const all = (sql: string, params: unknown[] = []): DBQuery => ({ sql, params, method: "all" });

test("transaction statements sent by the storage commit and roll back", async () => {
  const engine = await openSqlJsEngine();
  await engine.exec(run("CREATE TABLE t (v TEXT)"));
  await engine.exec(run("BEGIN"));
  await engine.exec(run("INSERT INTO t VALUES (?)", ["kept"]));
  await engine.exec(run("COMMIT"));
  await engine.exec(run("BEGIN"));
  await engine.exec(run("INSERT INTO t VALUES (?)", ["dropped"]));
  await engine.exec(run("ROLLBACK"));
  expect((await engine.exec(all("SELECT v FROM t"))).rows).toEqual([["kept"]]);
  await engine.close();
});

test("run returns no rows and get returns nothing when no row matches", async () => {
  const engine = await openSqlJsEngine();
  await engine.exec(run("CREATE TABLE t (v TEXT)"));
  expect(await engine.exec(run("INSERT INTO t VALUES (?)", ["a"]))).toEqual({ rows: [] });
  expect(
    (await engine.exec({ sql: "SELECT v FROM t WHERE v = ?", params: ["z"], method: "get" })).rows,
  ).toEqual([]);
  // Without a row mode, rows are positional arrays.
  expect((await engine.exec(all("SELECT v FROM t"))).rows).toEqual([["a"]]);
  await engine.close();
});

test("only committed state reaches the snapshot when used through a DB storage", async () => {
  const indexedDBFactory = new IDBFactory();
  const open = async () => {
    const engine = await openSqlJsEngine({ indexedDBName: "contract", indexedDBFactory });
    await engine.exec(run("CREATE TABLE IF NOT EXISTS t (v TEXT)"));
    return engine;
  };
  const storage = createLocalDBStorage({ dialect: "sqlite", open });
  await storage.exec(run("INSERT INTO t VALUES (?)", ["outside"]));
  await storage.transaction(async (tx) => {
    await tx.exec(run("INSERT INTO t VALUES (?)", ["committed"]));
  });
  await expect(
    storage.transaction(async (tx) => {
      await tx.exec(run("INSERT INTO t VALUES (?)", ["rolled back"]));
      throw new Error("abort");
    }),
  ).rejects.toThrow("abort");
  await storage.close();

  // A new engine (the next leader) sees exactly what was committed.
  const reopened = createLocalDBStorage({ dialect: "sqlite", open });
  expect((await reopened.exec(all("SELECT v FROM t ORDER BY v"))).rows).toEqual([
    ["committed"],
    ["outside"],
  ]);
  await reopened.close();
});

test("the page-side storage forwards worker and coordination options", () => {
  const endpoint = { postMessage: vi.fn(), onmessage: null };
  const storage = createSqlJsDBStorage({
    worker: () => endpoint,
    requestTimeoutMs: 1_000,
    transactionTimeoutMs: 2_000,
  });
  expect(storage.key).toBe("default");
  expect(storage.role).toBe("follower");
  expect(endpoint.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      t: "init",
      key: "default",
      requestTimeoutMs: 1_000,
      transactionTimeoutMs: 2_000,
      engineOptions: undefined,
    }),
  );
});
