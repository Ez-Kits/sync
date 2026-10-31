import { createLocalDBStorage, type DBQuery } from "@ez-kits/sync-client-core";
import { expect, test, vi } from "vite-plus/test";
import { createPGliteDBStorage } from "../src";
import { openPGliteEngine } from "../src/worker";

const run = (sql: string, params: unknown[] = []): DBQuery => ({ sql, params, method: "run" });
const all = (sql: string, params: unknown[] = []): DBQuery => ({ sql, params, method: "all" });

test("transaction statements sent by the storage commit and roll back", async () => {
  const engine = await openPGliteEngine();
  await engine.exec(run("CREATE TABLE t (v TEXT)"));
  await engine.exec(run("BEGIN"));
  await engine.exec(run("INSERT INTO t VALUES ($1)", ["kept"]));
  await engine.exec(run("COMMIT"));
  await engine.exec(run("BEGIN"));
  await engine.exec(run("INSERT INTO t VALUES ($1)", ["dropped"]));
  await engine.exec(run("ROLLBACK"));
  expect((await engine.exec(all("SELECT v FROM t"))).rows).toEqual([["kept"]]);
  await engine.close();
}, 30_000);

test("run returns no rows, even for statements that return some", async () => {
  const engine = await openPGliteEngine();
  await engine.exec(run("CREATE TABLE t (id SERIAL PRIMARY KEY, v TEXT)"));
  expect(await engine.exec(run("INSERT INTO t (v) VALUES ($1) RETURNING id", ["a"]))).toEqual({
    rows: [],
  });
  expect(
    (await engine.exec({ sql: "SELECT v FROM t WHERE v = $1", params: ["z"], method: "get" })).rows,
  ).toEqual([]);
  expect((await engine.exec({ ...all("SELECT id, v FROM t"), rowMode: "object" })).rows).toEqual([
    { id: 1, v: "a" },
  ]);
  await engine.close();
}, 30_000);

test("storage transactions are atomic on PGlite", async () => {
  const storage = createLocalDBStorage({
    dialect: "postgres",
    open: async () => {
      const engine = await openPGliteEngine();
      await engine.exec(run("CREATE TABLE t (v TEXT UNIQUE)"));
      return engine;
    },
  });
  await storage.transaction(async (tx) => {
    await tx.exec(run("INSERT INTO t VALUES ($1)", ["a"]));
  });
  // A failing statement inside a transaction rolls back the whole transaction.
  await expect(
    storage.transaction(async (tx) => {
      await tx.exec(run("INSERT INTO t VALUES ($1)", ["b"]));
      await tx.exec(run("INSERT INTO t VALUES ($1)", ["a"]));
    }),
  ).rejects.toThrow("duplicate key");
  expect((await storage.exec(all("SELECT v FROM t"))).rows).toEqual([["a"]]);
  await storage.close();
}, 30_000);

test("the page-side storage forwards worker and coordination options", () => {
  const endpoint = { postMessage: vi.fn(), onmessage: null };
  const storage = createPGliteDBStorage({
    key: "pg",
    worker: () => endpoint,
    requestTimeoutMs: 500,
  });
  expect(storage.key).toBe("pg");
  expect(endpoint.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ t: "init", key: "pg", requestTimeoutMs: 500 }),
  );
});
