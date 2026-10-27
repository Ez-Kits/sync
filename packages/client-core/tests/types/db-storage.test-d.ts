import { expectTypeOf, test } from "vite-plus/test";
import {
  createLocalDBStorage,
  createWorkerDBStorage,
  startDBStorageWorker,
  type DBEngine,
  type DBExecutor,
  type DBQueryResult,
  type DBRole,
  type DBStorage,
} from "../../src";
import { db, dbStorage } from "./fixtures";

declare const engine: DBEngine;

test("adapters expose the storage they run on", () => {
  expectTypeOf(db.dbStorage).toEqualTypeOf<DBStorage>();
  expectTypeOf(dbStorage.role).toEqualTypeOf<DBRole>();
  expectTypeOf<DBStorage["exec"]>().returns.resolves.toEqualTypeOf<DBQueryResult>();
  expectTypeOf(dbStorage.transaction(async () => "done")).resolves.toEqualTypeOf<string>();
  expectTypeOf<Parameters<DBStorage["transaction"]>[0]>().parameter(0).toEqualTypeOf<DBExecutor>();
});

test("storages are built for a dialect from a worker or an in-process engine", () => {
  expectTypeOf(
    createWorkerDBStorage({ dialect: "sqlite", worker: () => ({}) as Worker }),
  ).toEqualTypeOf<DBStorage>();
  expectTypeOf(
    createLocalDBStorage({ dialect: "postgres", open: () => engine }),
  ).toEqualTypeOf<DBStorage>();
  // @ts-expect-error unknown dialects are rejected
  createLocalDBStorage({ dialect: "mysql", open: () => engine });
  startDBStorageWorker<{ file: string }>((options, { signal }) => {
    expectTypeOf(options.file).toEqualTypeOf<string>();
    expectTypeOf(signal).toEqualTypeOf<AbortSignal>();
    return engine;
  });
  // @ts-expect-error statements need a method
  void dbStorage.exec({ sql: "select 1", params: [] });
});
