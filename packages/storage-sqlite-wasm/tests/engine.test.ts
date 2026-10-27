import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { expect, test, vi } from "vite-plus/test";
import { createSqliteWasmStorage } from "../src";
import { openSqliteWasmEngine } from "../src/worker";

test("runs migrations, binds parameters and returns rows in both row modes", async () => {
  const engine = await openSqliteWasmEngine({ filename: "/t.sqlite3", vfs: "memory" });
  await engine.exec({
    sql: "CREATE TABLE todos (id TEXT PRIMARY KEY, note TEXT); CREATE INDEX t ON todos (note);",
    params: [],
    method: "run",
  });
  await engine.exec({
    sql: "INSERT INTO todos VALUES (?, ?)",
    params: ["a", undefined],
    method: "run",
  });
  await engine.exec({ sql: "INSERT INTO todos VALUES (?, ?)", params: ["b", "x"], method: "run" });
  const select = "SELECT id, note FROM todos ORDER BY id";
  expect((await engine.exec({ sql: select, params: [], method: "all" })).rows).toEqual([
    ["a", null],
    ["b", "x"],
  ]);
  expect(
    (await engine.exec({ sql: select, params: [], method: "get", rowMode: "object" })).rows,
  ).toEqual([{ id: "a", note: null }]);
  await expect(
    engine.exec({ sql: "SELECT * FROM missing", params: [], method: "all" }),
  ).rejects.toThrow("no such table");
  await engine.close();
});

test("the OPFS pool is opened for the leader and paused when it steps down", async () => {
  const sqlite3 = await sqlite3InitModule();
  let paused = false;
  const pool = {
    OpfsSAHPoolDb: class extends sqlite3.oo1.DB {
      constructor(readonly filename: string) {
        super(":memory:");
      }
    },
    isPaused: () => paused,
    pauseVfs: vi.fn(() => {
      paused = true;
    }),
    unpauseVfs: vi.fn(async () => {
      paused = false;
      return pool;
    }),
  };
  const fake = { ...sqlite3, installOpfsSAHPoolVfs: vi.fn(async () => pool) } as never;

  const first = await openSqliteWasmEngine({ filename: "/todos.sqlite3", sqlite3: fake });
  expect((first.database as unknown as { filename: string }).filename).toBe("/todos.sqlite3");
  await first.close();
  expect(pool.pauseVfs).toHaveBeenCalledOnce();

  // Leading again in the same worker resumes the paused pool.
  const second = await openSqliteWasmEngine({
    filename: "/todos.sqlite3",
    poolName: "custom",
    sqlite3: fake,
  });
  expect(pool.unpauseVfs).toHaveBeenCalledOnce();
  expect((fake as any).installOpfsSAHPoolVfs).toHaveBeenLastCalledWith({ name: "custom" });
  await second.close();
});

test("the page-side storage speaks SQLite to its worker", () => {
  const endpoint = { postMessage: vi.fn(), onmessage: null };
  const storage = createSqliteWasmStorage({
    engineOptions: { filename: "/todos.sqlite3" },
    worker: () => endpoint,
  });
  expect(storage.dialect).toBe("sqlite");
});
