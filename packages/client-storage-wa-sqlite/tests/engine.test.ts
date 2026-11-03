import type { DBQuery } from "@ez-kits/sync-client-core";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createWaSqliteDBStorage } from "../src";
import { destroyWaSqliteDatabase, openWaSqliteEngine } from "../src/worker";

const opfs = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js", async () => {
  // OPFS needs a browser worker; stand in with an in-memory VFS.
  const { MemoryVFS } = await import("@journeyapps/wa-sqlite/src/examples/MemoryVFS.js");
  opfs.create.mockImplementation((name: string, module: unknown) =>
    (MemoryVFS as unknown as { create(n: string, m: unknown): Promise<SQLiteVFS> }).create(
      name,
      module,
    ),
  );
  return { OPFSCoopSyncVFS: opfs };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const run = (sql: string, params: unknown[] = []): DBQuery => ({ sql, params, method: "run" });
const all = (sql: string, params: unknown[] = []): DBQuery => ({ sql, params, method: "all" });

test("runs migrations, binds parameters and returns rows in both row modes", async () => {
  const engine = await openWaSqliteEngine({ filename: "t.sqlite3", vfs: "memory" });
  await engine.exec(
    run("CREATE TABLE todos (id TEXT PRIMARY KEY, note TEXT); CREATE INDEX t ON todos (note);"),
  );
  await engine.exec(run("INSERT INTO todos VALUES (?, ?)", ["a", undefined]));
  await engine.exec(run("INSERT INTO todos VALUES (?, ?) RETURNING id", ["b", "x"]));
  const select = "SELECT id, note FROM todos ORDER BY id";
  expect((await engine.exec(all(select))).rows).toEqual([
    ["a", null],
    ["b", "x"],
  ]);
  expect(
    (await engine.exec({ sql: select, params: [], method: "get", rowMode: "object" })).rows,
  ).toEqual([{ id: "a", note: null }]);
  await expect(engine.exec(all("SELECT * FROM missing"))).rejects.toThrow("no such table");
  // A failed statement does not block the next one.
  expect((await engine.exec(all("SELECT count(*) FROM todos"))).rows).toEqual([[2]]);
  await engine.close();
});

test("indexeddb keeps the database between leaders until it is destroyed", async () => {
  const options = { filename: "idb-todos.sqlite3", vfs: "indexeddb" } as const;
  const first = await openWaSqliteEngine(options);
  await first.exec(run("CREATE TABLE t (v TEXT)"));
  await first.exec(run("INSERT INTO t VALUES (?)", ["kept"]));
  await first.close();

  const second = await openWaSqliteEngine(options);
  expect((await second.exec(all("SELECT v FROM t"))).rows).toEqual([["kept"]]);
  await second.close();
  expect((await indexedDB.databases()).map((db) => db.name)).toContain("idb-todos.sqlite3");

  await destroyWaSqliteDatabase(options);
  expect((await indexedDB.databases()).map((db) => db.name)).not.toContain("idb-todos.sqlite3");
  const third = await openWaSqliteEngine(options);
  await expect(third.exec(all("SELECT v FROM t"))).rejects.toThrow("no such table");
  await third.close();
});

test("destroying an indexeddb database reports IndexedDB errors", async () => {
  const error = new DOMException("denied", "UnknownError");
  const request = {} as IDBOpenDBRequest & { error: DOMException };
  vi.stubGlobal("indexedDB", {
    deleteDatabase: () => {
      queueMicrotask(() => {
        request.error = error;
        request.onerror?.(new Event("error"));
      });
      return request;
    },
  });
  await expect(destroyWaSqliteDatabase({ filename: "x", vfs: "indexeddb" })).rejects.toBe(error);
});

test("opfs is the default and opens the file through OPFSCoopSyncVFS with the sync build", async () => {
  const loadModule = vi.fn(async (build: "sync" | "async") => {
    const { default: factory } = await import("@journeyapps/wa-sqlite/dist/wa-sqlite.mjs");
    expect(build).toBe("sync");
    return factory();
  });
  const engine = await openWaSqliteEngine({ filename: "/todos.sqlite3", loadModule });
  expect(loadModule).toHaveBeenCalledOnce();
  expect(opfs.create).toHaveBeenCalledWith("ez-sync-opfs", expect.anything());
  const vfs = (await opfs.create.mock.results[0]!.value) as SQLiteVFS & {
    mapNameToFile: Map<string, unknown>;
  };
  const close = vi.spyOn(vfs, "close");
  await engine.exec(run("CREATE TABLE t (v TEXT)"));
  expect([...vfs.mapNameToFile.keys()]).toContain("/todos.sqlite3");
  await engine.close();
  expect(close).toHaveBeenCalledOnce();
});

function fakeDirectory(entries: Record<string, unknown>) {
  const notFound = (name: string) => Promise.reject(new DOMException(name, "NotFoundError"));
  return {
    entries,
    getDirectoryHandle(name: string) {
      const entry = entries[name];
      return typeof entry === "object" && entry ? Promise.resolve(entry) : notFound(name);
    },
    removeEntry(name: string) {
      if (!(name in entries)) return notFound(name);
      delete entries[name];
      return Promise.resolve();
    },
  };
}

test("destroying an opfs database removes the file and its journals", async () => {
  const data = fakeDirectory({ "todos.sqlite3": 1, "todos.sqlite3-journal": 1, other: 1 });
  const root = fakeDirectory({ data, "todos.sqlite3": 1 });
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });

  await destroyWaSqliteDatabase({ filename: "/data/todos.sqlite3" });
  expect(Object.keys(data.entries)).toEqual(["other"]);
  expect(Object.keys(root.entries)).toEqual(["data", "todos.sqlite3"]);

  // A missing directory or file is nothing to delete; in-memory databases have no files.
  await destroyWaSqliteDatabase({ filename: "/missing/todos.sqlite3", vfs: "opfs" });
  await destroyWaSqliteDatabase({ filename: "todos.sqlite3", vfs: "memory" });
  expect(Object.keys(root.entries)).toEqual(["data", "todos.sqlite3"]);

  root.removeEntry = () => Promise.reject(new DOMException("locked", "NoModificationAllowedError"));
  await expect(destroyWaSqliteDatabase({ filename: "todos.sqlite3" })).rejects.toThrow("locked");
});

test("the page-side storage speaks SQLite to its worker", () => {
  const endpoint = { postMessage: vi.fn(), onmessage: null };
  const storage = createWaSqliteDBStorage({
    engineOptions: { filename: "todos.sqlite3" },
    worker: () => endpoint,
  });
  expect(storage.dialect).toBe("sqlite");
});
