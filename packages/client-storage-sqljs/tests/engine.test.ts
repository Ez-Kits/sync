import { IDBFactory } from "fake-indexeddb";
import initSqlJs from "sql.js";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createSqlJsDBStorage } from "../src";
import { destroySqlJsDatabase, openSqlJsEngine, sqlJsConfig } from "../src/worker";
import { loadSnapshot, saveSnapshot } from "../src/snapshot";

const run = (sql: string, params: unknown[] = []) => ({ sql, params, method: "run" as const });

afterEach(() => {
  vi.unstubAllGlobals();
});

test("runs migrations, binds parameters and returns rows in both row modes", async () => {
  const engine = await openSqlJsEngine();
  await engine.exec(
    run(
      "CREATE TABLE todos (id TEXT PRIMARY KEY, done INTEGER, note TEXT, n INTEGER); CREATE INDEX t ON todos (done);",
    ),
  );
  await engine.exec(run("INSERT INTO todos VALUES (?, ?, ?, ?)", ["a", true, undefined, 7n]));
  await engine.exec(run("INSERT INTO todos VALUES (?, ?, ?, ?)", ["b", false, "x", 1]));
  const select = "SELECT id, done, note, n FROM todos ORDER BY id";
  expect((await engine.exec({ sql: select, params: [], method: "all" })).rows).toEqual([
    ["a", 1, null, 7],
    ["b", 0, "x", 1],
  ]);
  expect(
    (await engine.exec({ sql: select, params: [], method: "get", rowMode: "object" })).rows,
  ).toEqual([{ id: "a", done: 1, note: null, n: 7 }]);
  expect(
    (await engine.exec({ sql: "SELECT id FROM todos WHERE id = ?", params: ["z"], method: "get" }))
      .rows,
  ).toEqual([]);
  await expect(engine.exec(run("SELECT * FROM missing"))).rejects.toThrow("no such table");
  await expect(
    engine.exec({ sql: "SELECT * FROM missing", params: [], method: "all" }),
  ).rejects.toThrow("no such table");
  // In-memory engines have nothing to flush.
  await engine.flush!();
  await engine.close();
});

test("persists snapshots to IndexedDB and restores them on the next open", async () => {
  const indexedDBFactory = new IDBFactory();
  const first = await openSqlJsEngine({ indexedDBName: "todos", indexedDBFactory });
  await first.exec(run("CREATE TABLE t (v TEXT)"));
  await first.exec(run("INSERT INTO t VALUES (?)", ["kept"]));
  await first.flush!();
  await first.close();

  // The global IndexedDB is the default.
  vi.stubGlobal("indexedDB", indexedDBFactory);
  const second = await openSqlJsEngine({ indexedDBName: "todos" });
  expect((await second.exec({ sql: "SELECT v FROM t", params: [], method: "all" })).rows).toEqual([
    ["kept"],
  ]);
  await second.close();

  const injected = await openSqlJsEngine({ sqlJs: initSqlJs() });
  expect(injected.database).toBeDefined();
  await injected.close();
});

test("snapshots written as views are read back; unknown formats are rejected", async () => {
  const location = { name: "formats", factory: new IDBFactory() };
  expect(await loadSnapshot(location)).toBeNull();
  await saveSnapshot(location, new Uint8Array([1, 2, 3]));
  expect(new Uint8Array((await loadSnapshot(location))!)).toEqual(new Uint8Array([1, 2, 3]));

  const put = (value: unknown) =>
    new Promise<void>((resolve) => {
      const request = location.factory.open("formats", 1);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("database", "readwrite");
        tx.objectStore("database").put(value, "snapshot");
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
  await put(new Uint8Array([4, 5]).subarray(1));
  expect(new Uint8Array((await loadSnapshot(location))!)).toEqual(new Uint8Array([5]));
  await put("not a snapshot");
  await expect(loadSnapshot(location)).rejects.toThrow("unsupported format");
});

/** An IndexedDB that fails at one stage. */
function failingFactory(stage: "open" | "get" | "put"): IDBFactory {
  const fail = (target: any) =>
    queueMicrotask(() => {
      target.error = new Error(`${stage} failed`);
      target.onerror();
    });
  const succeed = (target: any, result: unknown) =>
    queueMicrotask(() => {
      target.result = result;
      target.onupgradeneeded?.();
      target.onsuccess();
    });
  const db = {
    objectStoreNames: { contains: () => true },
    close: vi.fn(),
    transaction: (_store: string, mode: string) => {
      const transaction: any = {
        objectStore: () => ({
          get: () => {
            const request: any = {};
            if (stage === "get") fail(request);
            else succeed(request, undefined);
            return request;
          },
          put: () => {},
        }),
      };
      if (stage === "put" && mode === "readwrite") fail(transaction);
      return transaction;
    },
  };
  return {
    open: () => {
      const request: any = {};
      if (stage === "open") fail(request);
      else succeed(request, db);
      return request;
    },
  } as unknown as IDBFactory;
}

test("IndexedDB failures surface", async () => {
  await expect(loadSnapshot({ name: "x", factory: failingFactory("open") })).rejects.toThrow(
    "open failed",
  );
  await expect(loadSnapshot({ name: "x", factory: failingFactory("get") })).rejects.toThrow(
    "get failed",
  );
  expect(await loadSnapshot({ name: "x", factory: failingFactory("put") })).toBeNull();
  await expect(
    saveSnapshot({ name: "x", factory: failingFactory("put") }, new Uint8Array()),
  ).rejects.toThrow("put failed");
});

test("the page-side storage speaks SQLite to its worker", () => {
  const endpoint = { postMessage: vi.fn(), onmessage: null };
  const storage = createSqlJsDBStorage({
    key: "todos",
    engineOptions: { indexedDBName: "todos" },
    worker: () => endpoint,
  });
  expect(storage.dialect).toBe("sqlite");
  expect(endpoint.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ t: "init", key: "todos", engineOptions: { indexedDBName: "todos" } }),
  );
});

test("sql.js loads its wasm from wasmUrl when given", () => {
  expect(sqlJsConfig(undefined)).toBeUndefined();
  expect(sqlJsConfig("/assets/sql-wasm.wasm")?.locateFile?.("sql-wasm.wasm", "")).toBe(
    "/assets/sql-wasm.wasm",
  );
});

test("destroySqlJsDatabase deletes the IndexedDB snapshot", async () => {
  const indexedDBFactory = new IDBFactory();
  const first = await openSqlJsEngine({ indexedDBName: "todos", indexedDBFactory });
  await first.exec(run("CREATE TABLE t (v TEXT)"));
  await first.flush!();
  await first.close();

  await destroySqlJsDatabase({ indexedDBName: "todos", indexedDBFactory });
  expect(await indexedDBFactory.databases()).toEqual([]);
  const reopened = await openSqlJsEngine({ indexedDBName: "todos", indexedDBFactory });
  await expect(reopened.exec(run("SELECT * FROM t"))).rejects.toThrow("no such table");
  await reopened.close();

  // Deleting again, or an in-memory database, does nothing.
  await destroySqlJsDatabase({ indexedDBName: "todos", indexedDBFactory });
  await destroySqlJsDatabase();
});

test("a failed snapshot delete surfaces", async () => {
  const error = new Error("delete failed");
  const factory = {
    deleteDatabase: () => {
      const request = { error, onerror: undefined as (() => void) | undefined };
      queueMicrotask(() => request.onerror?.());
      return request;
    },
  } as unknown as IDBFactory;
  await expect(
    destroySqlJsDatabase({ indexedDBName: "x", indexedDBFactory: factory }),
  ).rejects.toBe(error);
});
