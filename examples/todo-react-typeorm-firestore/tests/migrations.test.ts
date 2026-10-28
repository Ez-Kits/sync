import { openSqlJsEngine } from "@ez-kits/sync-storage-sqljs/worker";
import { expect, test } from "vite-plus/test";
import { migrateLocalSchema } from "../src/db/migrations";

const columns = async (engine: Awaited<ReturnType<typeof openSqlJsEngine>>) =>
  (await engine.exec({ sql: "PRAGMA table_info(todos)", params: [], method: "all" })).rows.map(
    (column) => (column as unknown[])[1],
  );

test("creates the local schema and is safe to run again", async () => {
  const engine = await openSqlJsEngine();
  await migrateLocalSchema(engine);
  await migrateLocalSchema(engine);
  expect(await columns(engine)).toContain("deleted");
  const tables = await engine.exec({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    params: [],
    method: "all",
  });
  // Only the app's own tables: the sync client creates its outbox tables itself.
  expect(tables.rows.flat()).toEqual(["todos"]);
  await engine.close();
});

test("adds the deleted column to databases created before it existed", async () => {
  const engine = await openSqlJsEngine();
  await engine.exec({
    sql: "CREATE TABLE todos (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 0)",
    params: [],
    method: "run",
  });
  await migrateLocalSchema(engine);
  expect(await columns(engine)).toContain("deleted");
  await engine.close();
});
