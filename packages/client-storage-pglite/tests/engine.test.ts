import { expect, test, vi } from "vite-plus/test";
import { createPGliteDBStorage } from "../src";
import { destroyPGliteDatabase, openPGliteEngine } from "../src/worker";

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
  const storage = createPGliteDBStorage({
    engineOptions: { dataDir: "idb://todos" },
    worker: () => endpoint,
  });
  expect(storage.dialect).toBe("postgres");
  expect(endpoint.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ t: "init", engineOptions: { dataDir: "idb://todos" } }),
  );
});

/** OPFS directories as nested maps; `removeEntry` reports a missing entry like the browser. */
interface FakeDirectory {
  entries: Record<string, FakeDirectory>;
  getDirectoryHandle: ReturnType<typeof vi.fn>;
  removeEntry: ReturnType<typeof vi.fn>;
}

function directory(entries: Record<string, FakeDirectory> = {}): FakeDirectory {
  const notFound = () => Object.assign(new Error("missing"), { name: "NotFoundError" });
  const handle = {
    entries,
    getDirectoryHandle: vi.fn(async (name: string) => {
      if (!entries[name]) throw notFound();
      return entries[name];
    }),
    removeEntry: vi.fn(async (name: string, _options: { recursive: boolean }) => {
      if (!entries[name]) throw notFound();
      delete entries[name];
    }),
  };
  return handle;
}

function deletingFactory(error?: Error) {
  const deleted: string[] = [];
  const factory = {
    deleted,
    deleteDatabase: (name: string) => {
      const request = {
        error,
        onsuccess: undefined as (() => void) | undefined,
        onerror: undefined as (() => void) | undefined,
      };
      queueMicrotask(() => {
        if (error) request.onerror?.();
        else {
          deleted.push(name);
          request.onsuccess?.();
        }
      });
      return request;
    },
  };
  return factory;
}

test("destroyPGliteDatabase deletes idb:// and opfs-ahp:// data dirs", async () => {
  const indexedDB = deletingFactory();
  const root = directory({ apps: directory({ todos: directory(), other: directory() }) });
  const host = { indexedDB, navigator: { storage: { getDirectory: async () => root } } } as never;

  await destroyPGliteDatabase({ dataDir: "idb://todos" }, host);
  expect(indexedDB.deleted).toEqual(["/pglite/todos"]);

  await destroyPGliteDatabase({ dataDir: "opfs-ahp://apps/todos" }, host);
  expect(Object.keys(root.entries.apps!.entries)).toEqual(["other"]);
  expect(root.entries.apps!.removeEntry).toHaveBeenCalledWith("todos", { recursive: true });
  // Already gone, or no path: nothing to do.
  await destroyPGliteDatabase({ dataDir: "opfs-ahp://apps/todos" }, host);
  await destroyPGliteDatabase({ dataDir: "opfs-ahp://missing/todos" }, host);
  await destroyPGliteDatabase({ dataDir: "opfs-ahp://" }, host);

  // In-memory databases have nothing to delete.
  await destroyPGliteDatabase();
  await destroyPGliteDatabase({ dataDir: "memory://x" }, host);
  expect(indexedDB.deleted).toHaveLength(1);
});

test("destroyPGliteDatabase surfaces failures and refuses file-system data dirs", async () => {
  const error = new Error("blocked");
  await expect(
    destroyPGliteDatabase({ dataDir: "idb://todos" }, {
      indexedDB: deletingFactory(error),
    } as never),
  ).rejects.toBe(error);

  const root = directory({ todos: directory() });
  root.removeEntry.mockRejectedValueOnce(new Error("in use"));
  const host = { navigator: { storage: { getDirectory: async () => root } } } as never;
  await expect(destroyPGliteDatabase({ dataDir: "opfs-ahp://todos" }, host)).rejects.toThrow(
    "in use",
  );

  await expect(destroyPGliteDatabase({ dataDir: "./data" })).rejects.toThrow(
    "remove the directory yourself",
  );
});
