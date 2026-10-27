import { expect, test, vi } from "vite-plus/test";
import { createPGliteStorage } from "../src";
import { openPGliteEngine } from "../src/worker";

test("runs migrations, binds parameters and returns rows in both row modes", async () => {
  const engine = await openPGliteEngine();
  await engine.exec({
    sql: "CREATE TABLE todos (id TEXT PRIMARY KEY, done BOOLEAN); CREATE INDEX t ON todos (done);",
    params: [],
    method: "run",
  });
  await engine.exec({ sql: "BEGIN", params: [], method: "run" });
  await engine.exec({
    sql: "INSERT INTO todos VALUES ($1, $2), ($3, $4)",
    params: ["a", true, "b", false],
    method: "run",
  });
  await engine.exec({ sql: "COMMIT", params: [], method: "run" });
  const select = "SELECT id, done FROM todos WHERE id <> $1 ORDER BY id";
  expect((await engine.exec({ sql: select, params: ["z"], method: "all" })).rows).toEqual([
    ["a", true],
    ["b", false],
  ]);
  expect(
    (await engine.exec({ sql: select, params: ["z"], method: "get", rowMode: "object" })).rows,
  ).toEqual([{ id: "a", done: true }]);
  await expect(
    engine.exec({ sql: "SELECT * FROM missing", params: [], method: "all" }),
  ).rejects.toThrow('relation "missing" does not exist');
  await engine.close();
}, 30_000);

test("PGlite options are passed through", async () => {
  const engine = await openPGliteEngine({ dataDir: "memory://options", pglite: { debug: 0 } });
  expect(engine.database.dataDir).toBe("memory://options");
  await engine.close();
}, 30_000);

test("the page-side storage speaks Postgres to its worker", () => {
  const endpoint = { postMessage: vi.fn(), onmessage: null };
  const storage = createPGliteStorage({
    engineOptions: { dataDir: "idb://todos" },
    worker: () => endpoint,
  });
  expect(storage.dialect).toBe("postgres");
  expect(endpoint.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ t: "init", engineOptions: { dataDir: "idb://todos" } }),
  );
});
