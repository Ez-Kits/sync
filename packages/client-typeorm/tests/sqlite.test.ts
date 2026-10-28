import "reflect-metadata";
import {
  createLocalDBStorage,
  isRetriableError,
  LeaderChangedError,
  type DBStorage,
} from "@ez-kits/sync-client-core";
import { openSqlJsEngine } from "@ez-kits/sync-storage-sqljs/worker";
import { Column, Entity, PrimaryColumn } from "typeorm";
import { expect, test, vi } from "vite-plus/test";
import { defineTypeormCollection } from "../src/collection";
import { createTypeOrmSqliteDBAdapter, createTypeOrmSqliteDriver } from "../src/sqlite";

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

async function setup(
  storage: DBStorage = createLocalDBStorage({ dialect: "sqlite", open: () => openSqlJsEngine() }),
) {
  await storage.exec({
    sql: "CREATE TABLE todos (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0)",
    params: [],
    method: "run",
  });
  // The adapter creates the data source; the outbox entities are its own.
  const adapter = createTypeOrmSqliteDBAdapter({ dbStorage: storage, collections: [collection] });
  const db = adapter.db;
  const rows = async (sql: string) =>
    (await storage.exec({ sql, params: [], method: "all", rowMode: "object" })).rows;
  return { storage, db, adapter, rows };
}

test("runs the adapter and its outbox on the storage, initializing the data source", async () => {
  const { db, adapter, rows } = await setup();
  expect(db.isInitialized).toBe(false);
  await adapter.localChangeStore.initialize();
  await adapter.localChangeStore.initialize();
  expect(db.isInitialized).toBe(true);
  expect(await rows("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).toEqual([
    { name: "ez_sync_dirty_records" },
    { name: "ez_sync_events" },
    { name: "todos" },
  ]);

  await adapter.insert("todos", { id: "a", title: "one", completed: false });
  await adapter.update("todos", { id: "a", completed: true });
  expect(await adapter.get("todos", "a")).toMatchObject({ id: "a", title: "one", completed: true });
  await adapter.commitLocalMutation({
    mutate: ({ operations }) => operations.insert("todos", { id: "b", title: "two" }),
    persistOutboxEvent: ({ native }) =>
      adapter.localChangeStore.appendEvents(
        [
          {
            id: "e1",
            type: "create",
            collection: "todos",
            data: { id: "b" },
            recordId: "b",
            createdAt: 1,
          },
        ],
        native,
      ),
    persistDirtyRecord: ({ native }) =>
      adapter.localChangeStore.upsertDirtyRecord(
        { collection: "todos", recordId: "b", state: "dirty", updatedAt: 1 },
        native,
      ),
  });
  expect(await adapter.getMany("todos")).toHaveLength(2);
  // Typed repositories on the data source the adapter exposes to live queries.
  expect(await db.repositories.todos.findOneBy({ id: "b" })).toMatchObject({ title: "two" });
  expect(await adapter.localChangeStore.getPendingEvents()).toMatchObject([{ id: "e1" }]);
  expect(await adapter.localChangeStore.getDirtyRecords()).toMatchObject([{ recordId: "b" }]);
  await adapter.delete("todos", "a");
  await expect(adapter.get("todos", "a")).rejects.toThrow();
  await db.destroy();
});

test("reads run on the storage; writes commit on their own and report their changes", async () => {
  const { storage, db, rows } = await setup();
  await db.initialize();
  const transaction = vi.spyOn(storage, "transaction");
  const runner = db.createQueryRunner();
  await runner.query("INSERT INTO todos (id, title) VALUES ('a', 'one'), ('b', 'two')");
  const updated = await runner.query("UPDATE todos SET completed = ?", [1], true);
  expect(updated.affected).toBe(2);
  expect(transaction).toHaveBeenCalledTimes(2);
  // Unrecognized statements are treated as writes.
  expect(await runner.query("/* count */ SELECT count(*) AS n FROM todos")).toEqual([{ n: 2 }]);
  expect(transaction).toHaveBeenCalledTimes(3);
  expect(await runner.query("SELECT id FROM todos ORDER BY id")).toEqual([
    { id: "a" },
    { id: "b" },
  ]);
  expect(transaction).toHaveBeenCalledTimes(3);
  expect(await rows("SELECT completed FROM todos")).toEqual([{ completed: 1 }, { completed: 1 }]);
  await db.destroy();
});

test("transactions commit or roll back as a whole, and savepoints roll back alone", async () => {
  const { db, adapter } = await setup();
  await adapter.localChangeStore.initialize();
  await expect(
    adapter.transaction(async (tx) => {
      await tx.insert("todos", { id: "lost", title: "rolled back" });
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  await db.transaction(async (manager) => {
    await manager.getRepository(Todo).save({ id: "kept", title: "outer" });
    await manager
      .transaction(async (inner) => {
        await inner.getRepository(Todo).save({ id: "dropped", title: "inner" });
        throw new Error("inner");
      })
      .catch(() => undefined);
  });
  expect((await adapter.getMany("todos")).map((todo) => todo.id)).toEqual(["kept"]);
  await db.destroy();
});

test("concurrent transactions run one at a time", async () => {
  const { db, adapter } = await setup();
  await adapter.localChangeStore.initialize();
  const write = (id: string) =>
    adapter.transaction(async (tx) => {
      await tx.insert("todos", { id, title: id });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await tx.update("todos", { id, completed: true });
    });
  await Promise.all([write("a"), write("b"), write("c")]);
  expect((await adapter.getMany("todos")).every((todo) => todo.completed)).toBe(true);
  await db.destroy();
});

test("a transaction that cannot open or commit fails with the storage's error", async () => {
  const base = createLocalDBStorage({ dialect: "sqlite", open: () => openSqlJsEngine() });
  let failure: "begin" | "commit" | undefined;
  const storage: DBStorage = Object.assign(Object.create(base) as DBStorage, {
    transaction: async <T>(fn: Parameters<DBStorage["transaction"]>[0]) => {
      if (failure === "begin") throw new LeaderChangedError();
      const result = (await base.transaction(fn)) as T;
      if (failure === "commit") throw new LeaderChangedError();
      return result;
    },
  });
  const { db, adapter } = await setup(storage);
  await adapter.localChangeStore.initialize();
  for (failure of ["begin", "commit"] as const) {
    const error = await adapter
      .transaction((tx) => tx.insert("todos", { id: failure as string, title: "x" }))
      .catch((caught: unknown) => caught);
    // TypeORM wraps the error but keeps `retriable`, so the sync client retries the commit.
    expect(isRetriableError(error)).toBe(true);
  }
  failure = undefined;
  // A failed open must not leave TypeORM's shared query runner mid-transaction.
  await adapter.transaction((tx) => tx.insert("todos", { id: "after", title: "still works" }));
  // The fake "commit" failure loses the acknowledgement after the commit, not the write.
  expect((await adapter.getMany("todos")).map((todo) => todo.id)).toEqual(["commit", "after"]);
  await db.destroy();
});

test("the connection ends transactions on close and rejects a nested BEGIN", async () => {
  const { storage, rows } = await setup();
  const connection = await createTypeOrmSqliteDriver(storage).openDatabaseAsync("test");
  await connection.runAsync("BEGIN");
  await expect(connection.runAsync("BEGIN")).rejects.toThrow("already open");
  await connection.runAsync("INSERT INTO todos (id, title) VALUES (?, ?)", "a", "one");
  await connection.closeAsync();
  expect(await rows("SELECT id FROM todos")).toEqual([]);

  await connection.runAsync("BEGIN");
  const statement = await connection.prepareAsync(
    "INSERT INTO todos (id, title) VALUES ('b', 'two')",
  );
  const result = await statement.executeAsync();
  expect(result.changes).toBe(1);
  await statement.finalizeAsync();
  await connection.runAsync("END");
  await connection.runAsync("COMMIT");
  // A transaction without statements never opens one on the storage.
  await connection.runAsync("BEGIN");
  await connection.runAsync("ROLLBACK");
  await connection.closeAsync();
  expect(await rows("SELECT id FROM todos")).toEqual([{ id: "b" }]);
});

test("the driver needs a sqlite storage", () => {
  const storage = createLocalDBStorage({ dialect: "postgres", open: () => openSqlJsEngine() });
  expect(() => createTypeOrmSqliteDriver(storage)).toThrow("needs a sqlite storage");
});
