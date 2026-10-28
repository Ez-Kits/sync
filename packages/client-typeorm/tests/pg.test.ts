import "reflect-metadata";
import { createLocalDBStorage, createSyncClient, type DBStorage } from "@ez-kits/sync-client-core";
import { openPGliteEngine } from "@ez-kits/sync-storage-pglite/worker";
import { Column, Entity, PrimaryColumn } from "typeorm";
import { expect, test, vi } from "vite-plus/test";
import { defineTypeormCollection } from "../src/collection";
import { createTypeOrmPgDBAdapter, createTypeOrmPgDriver, pgLocalChangeEntities } from "../src/pg";

class Todo {
  id!: string;
  title!: string;
  completed!: boolean;
}
Entity("todos")(Todo);
PrimaryColumn("text")(Todo.prototype, "id");
Column("text")(Todo.prototype, "title");
Column("boolean", { default: false })(Todo.prototype, "completed");

const collection = defineTypeormCollection({ name: "todos", entity: Todo, primaryField: "id" });

function pgStorage() {
  return createLocalDBStorage({
    dialect: "postgres",
    open: async () => {
      const engine = await openPGliteEngine();
      await engine.exec({
        sql: "CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, completed BOOLEAN NOT NULL DEFAULT false)",
        params: [],
        method: "run",
      });
      return engine;
    },
  });
}

const rowsOf = async (storage: DBStorage, sql: string) =>
  (await storage.exec({ sql, params: [], method: "all", rowMode: "object" })).rows;

test("a sync client writes through the adapter, its outbox created by the adapter", async () => {
  const dbStorage = pgStorage();
  const adapter = createTypeOrmPgDBAdapter({ dbStorage, collections: [collection] });
  const client = createSyncClient({
    collections: [collection],
    dbAdapter: adapter,
    checkpointStorage: {
      getCheckpoint: async () => undefined,
      saveCheckpoint: async () => {},
    },
  });

  await client.collections.todos.insert({ id: "a", title: "first" });
  await client.collections.todos.update({ id: "a", completed: true });
  await client.collections.todos.insert({ id: "b", title: "second" });
  await client.collections.todos.delete("b");
  expect(await client.collections.todos.get("a")).toEqual({
    id: "a",
    title: "first",
    completed: true,
  });
  expect(
    (
      await rowsOf(
        dbStorage,
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      )
    ).map((row) => (row as { table_name: string }).table_name),
  ).toEqual(["ez_sync_dirty_records", "ez_sync_events", "ez_sync_meta", "todos"]);

  // Outbox rows keep their JSON payload and numeric timestamps.
  const pending = await adapter.localChangeStore.getPendingEvents("todos");
  // Commit order, whatever the clock said.
  expect(pending.map((event) => `${event.type}:${event.recordId}`)).toEqual([
    "create:a",
    "update:a",
    "create:b",
    "delete:b",
  ]);
  const created = pending.find((event) => event.type === "create" && event.recordId === "a")!;
  expect(created.data).toEqual({ id: "a", title: "first" });
  expect(typeof created.createdAt).toBe("number");
  expect(await adapter.localChangeStore.getDirtyRecords("todos")).toEqual([
    expect.objectContaining({ recordId: "a", state: "dirty", updatedAt: expect.any(Number) }),
    expect.objectContaining({ recordId: "b", state: "deleted" }),
  ]);

  // A failing write leaves neither the row nor its outbox event behind.
  await expect(client.collections.todos.insert({ id: "a", title: "duplicate" })).rejects.toThrow();
  expect(await adapter.localChangeStore.getPendingEvents()).toHaveLength(4);

  // Live queries get the typed data source.
  const onData = vi.fn();
  client.liveQuery({
    collections: ["todos"],
    query: (db, schema) => db.getRepository(schema.todos).count(),
    onData,
  });
  await vi.waitFor(() => expect(onData).toHaveBeenCalledWith(1));
  expect(await adapter.db.repositories.todos.findOneBy({ id: "a" })).toMatchObject({
    completed: true,
  });
  await client.dispose();
}, 30_000);

test("adapter transactions roll back together and run one at a time", async () => {
  const dbStorage = pgStorage();
  const adapter = createTypeOrmPgDBAdapter({
    dbStorage,
    collections: [collection],
    dataSourceOptions: { logging: false },
  });
  await adapter.localChangeStore.initialize();
  await expect(
    adapter.transaction(async (tx) => {
      await tx.insert("todos", { id: "x", title: "rolled back" });
      throw new Error("abort");
    }),
  ).rejects.toThrow("abort");
  await Promise.all([
    adapter.transaction((tx) => tx.insert("todos", { id: "p", title: "one" })),
    adapter.transaction((tx) => tx.insert("todos", { id: "q", title: "two" })),
  ]);
  expect((await adapter.getMany("todos")).map((todo) => todo.id).sort()).toEqual(["p", "q"]);
  await adapter.db.destroy();
  await dbStorage.close();
}, 30_000);

test("the pg module routes statements, transactions and savepoints through the storage", async () => {
  const dbStorage = pgStorage();
  await dbStorage.ready;
  const transaction = vi.spyOn(dbStorage, "transaction");
  const { Pool } = createTypeOrmPgDriver(dbStorage);
  const pool = new Pool({});
  expect(pool.on("error", () => {})).toBe(pool);
  const client = await new Promise<
    Parameters<Parameters<InstanceType<typeof Pool>["connect"]>[0]>[1]
  >((resolve) => pool.connect((_error, connection) => resolve(connection)));
  expect(client.on("notice", () => {})).toBe(client);
  expect(client.removeListener("notice", () => {})).toBe(client);

  // Reads run on the storage; writes commit on their own and report affected rows.
  expect(await client.query("SELECT count(*)::int AS n FROM todos")).toEqual({
    rows: [{ n: 0 }],
    rowCount: 1,
    command: "SELECT",
  });
  expect(transaction).not.toHaveBeenCalled();
  expect(await client.query("INSERT INTO todos (id, title) VALUES ($1, $2)", ["a", "one"])).toEqual(
    { rows: [], rowCount: 1, command: "INSERT" },
  );
  expect(transaction).toHaveBeenCalledOnce();

  // A transaction commits as a whole; a savepoint rolls back alone.
  await client.query("START TRANSACTION");
  await expect(client.query("START TRANSACTION")).rejects.toThrow("already open");
  await client.query("INSERT INTO todos (id, title) VALUES ('b', 'two')");
  await client.query("SAVEPOINT typeorm_1");
  await client.query("INSERT INTO todos (id, title) VALUES ('c', 'three')");
  await client.query("ROLLBACK TO SAVEPOINT typeorm_1");
  expect(await client.query("COMMIT")).toMatchObject({ command: "COMMIT" });
  await client.query("START TRANSACTION");
  await client.query("UPDATE todos SET title = 'gone' WHERE id = 'a'");
  await client.query("ROLLBACK");
  expect(await rowsOf(dbStorage, "SELECT id, title FROM todos ORDER BY id")).toEqual([
    { id: "a", title: "one" },
    { id: "b", title: "two" },
  ]);

  // Releasing a client mid-transaction rolls it back; ending the pool leaves the storage open.
  const released = await new Promise<{ query: typeof client.query; release: () => void }>(
    (resolve) => pool.connect((_error, connection, release) => resolve({ ...connection, release })),
  );
  await released.query("BEGIN");
  await released.query("DELETE FROM todos");
  released.release();
  await vi.waitFor(async () =>
    expect(await rowsOf(dbStorage, "SELECT id FROM todos ORDER BY id")).toHaveLength(2),
  );
  const ended = vi.fn();
  pool.end(ended);
  pool.end();
  expect(ended).toHaveBeenCalledOnce();
  expect(await rowsOf(dbStorage, "SELECT id FROM todos ORDER BY id")).toHaveLength(2);
  await dbStorage.close();
}, 30_000);

test("the Postgres driver and adapter need a postgres storage", () => {
  const sqlite = createLocalDBStorage({
    dialect: "sqlite",
    open: () => ({ exec: async () => ({ rows: [] }), close: async () => {} }),
  });
  expect(() => createTypeOrmPgDriver(sqlite)).toThrow("needs a postgres storage");
  expect(() => createTypeOrmPgDBAdapter({ dbStorage: sqlite, collections: [collection] })).toThrow(
    "built for postgres but the storage speaks sqlite",
  );
});

test("writes count their returned rows when the engine does not report changes", async () => {
  const dbStorage = createLocalDBStorage({
    dialect: "postgres",
    open: () => ({
      exec: async () => ({ rows: [{ id: "a" }, { id: "b" }] }),
      close: async () => {},
    }),
  });
  const { Pool } = createTypeOrmPgDriver(dbStorage);
  const client = await new Promise<{ query: (sql: string) => Promise<unknown> }>((resolve) =>
    new Pool().connect((_error, connection) => resolve(connection)),
  );
  expect(await client.query("UPDATE todos SET title = 'x' RETURNING id")).toMatchObject({
    rowCount: 2,
    command: "UPDATE",
  });
  await dbStorage.close();
});

test("bigint outbox timestamps read back as numbers, keeping nulls", () => {
  const transformer = pgLocalChangeEntities.events.options.columns.createdAt!.transformer as {
    to(value: unknown): unknown;
    from(value: unknown): unknown;
  };
  expect(transformer.from("1700000000000")).toBe(1_700_000_000_000);
  expect(transformer.from(null)).toBeNull();
  expect(transformer.to(5)).toBe(5);
});
