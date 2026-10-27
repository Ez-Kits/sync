import { createLocalDBStorage, type DBQuery } from "@ez-kits/sync-client-core";
import { expect, test, vi } from "vite-plus/test";
import { createSqliteWasmStorage } from "../src";
import { openSqliteWasmEngine } from "../src/worker";

const run = (sql: string, params: unknown[] = []): DBQuery => ({ sql, params, method: "run" });
const all = (sql: string, params: unknown[] = []): DBQuery => ({ sql, params, method: "all" });
const memory = () => openSqliteWasmEngine({ filename: "/contract.sqlite3", vfs: "memory" });

test("transaction statements sent by the storage commit and roll back", async () => {
  const engine = await memory();
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
  const engine = await memory();
  await engine.exec(run("CREATE TABLE t (v TEXT)"));
  expect(await engine.exec(run("INSERT INTO t VALUES (?)", ["a"]))).toEqual({ rows: [] });
  expect(
    (await engine.exec({ sql: "SELECT v FROM t WHERE v = ?", params: ["z"], method: "get" })).rows,
  ).toEqual([]);
  await engine.close();
});

test("storage transactions are atomic on SQLite WASM", async () => {
  const storage = createLocalDBStorage({
    dialect: "sqlite",
    open: async () => {
      const engine = await memory();
      await engine.exec(run("CREATE TABLE t (v TEXT UNIQUE)"));
      return engine;
    },
  });
  await storage.transaction(async (tx) => {
    await tx.exec(run("INSERT INTO t VALUES (?)", ["a"]));
  });
  await expect(
    storage.transaction(async (tx) => {
      await tx.exec(run("INSERT INTO t VALUES (?)", ["b"]));
      await tx.exec(run("INSERT INTO t VALUES (?)", ["a"]));
    }),
  ).rejects.toThrow("UNIQUE constraint failed");
  expect((await storage.exec(all("SELECT v FROM t"))).rows).toEqual([["a"]]);
  await storage.close();
});

test("the page-side storage forwards worker and coordination options", () => {
  const endpoint = { postMessage: vi.fn(), onmessage: null };
  const storage = createSqliteWasmStorage({
    key: "wasm",
    engineOptions: { filename: "/todos.sqlite3", poolName: "todos" },
    worker: () => endpoint,
  });
  expect(storage.dialect).toBe("sqlite");
  expect(endpoint.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      t: "init",
      key: "wasm",
      engineOptions: { filename: "/todos.sqlite3", poolName: "todos" },
    }),
  );
});
