import type { DBEngine, DBQuery, DBQueryResult } from "@ez-kits/sync-client-core";
import { Factory, SQLITE_ROW } from "@journeyapps/wa-sqlite";
import type { WaSqliteEngineOptions } from "./options";

type Vfs = NonNullable<WaSqliteEngineOptions["vfs"]>;

export interface OpenWaSqliteEngineOptions extends WaSqliteEngineOptions {
  /**
   * Load the Emscripten module, e.g. to pass `locateFile` or `wasmBinary`. Defaults to the
   * package's `dist/wa-sqlite.mjs` for `opfs` and `memory`, and `dist/wa-sqlite-async.mjs`
   * for `indexeddb`. A custom module must be the matching (synchronous or asynchronous) build.
   */
  loadModule?: (build: "sync" | "async") => Promise<unknown>;
}

export interface WaSqliteEngine extends DBEngine {
  /** The wa-sqlite API and database handle, for migrations or tooling. */
  readonly sqlite3: ReturnType<typeof Factory>;
  readonly db: number;
}

/** OPFSCoopSyncVFS keeps these files for each database. */
const DATABASE_FILE_SUFFIXES = ["", "-journal", "-wal"];

function toBindable(value: unknown): SQLiteCompatibleType | null {
  return value === undefined ? null : (value as SQLiteCompatibleType);
}

async function defaultModule(build: "sync" | "async"): Promise<unknown> {
  const { default: factory } =
    build === "async"
      ? await import("@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs")
      : await import("@journeyapps/wa-sqlite/dist/wa-sqlite.mjs");
  return factory();
}

async function createVfs(vfs: Vfs, module: unknown, filename: string): Promise<SQLiteVFS> {
  if (vfs === "indexeddb") {
    const { IDBBatchAtomicVFS } =
      await import("@journeyapps/wa-sqlite/src/examples/IDBBatchAtomicVFS.js");
    // The package types predate the async `create` factory.
    const factory = IDBBatchAtomicVFS as unknown as {
      create(name: string, module: unknown, options: { idbName: string }): Promise<SQLiteVFS>;
    };
    return factory.create("ez-sync-idb", module, { idbName: filename });
  }
  const { OPFSCoopSyncVFS } =
    await import("@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js");
  return OPFSCoopSyncVFS.create("ez-sync-opfs", module);
}

async function execute(sqlite3: SQLiteAPI, db: number, query: DBQuery): Promise<DBQueryResult> {
  const rows: unknown[] = [];
  for await (const stmt of sqlite3.statements(db, query.sql)) {
    if (query.params.length > 0) sqlite3.bind_collection(stmt, query.params.map(toBindable));
    const columns = sqlite3.column_names(stmt);
    while ((await sqlite3.step(stmt)) === SQLITE_ROW) {
      if (query.method === "run") continue;
      const row = sqlite3.row(stmt);
      rows.push(
        query.rowMode === "object"
          ? Object.fromEntries(columns.map((column, i) => [column, row[i]]))
          : row,
      );
    }
  }
  return { rows: query.method === "get" ? rows.slice(0, 1) : rows };
}

/**
 * Open wa-sqlite in this (leader) worker, saved to OPFS or IndexedDB as `vfs` says. Every
 * open loads its own module, and `close` releases the VFS, so the next leader can open it.
 */
export async function openWaSqliteEngine(
  options: OpenWaSqliteEngineOptions,
): Promise<WaSqliteEngine> {
  const vfsName = options.vfs ?? "opfs";
  const loadModule = options.loadModule ?? defaultModule;
  const module = await loadModule(vfsName === "indexeddb" ? "async" : "sync");
  const sqlite3 = Factory(module);
  let vfs: SQLiteVFS | undefined;
  if (vfsName !== "memory") {
    vfs = await createVfs(vfsName, module, options.filename);
    sqlite3.vfs_register(vfs, true);
  }
  const db = await sqlite3.open_v2(vfs ? options.filename : ":memory:");

  // wa-sqlite calls on one database must not interleave.
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task);
    queue = result.catch(() => undefined);
    return result;
  };
  return {
    sqlite3,
    db,
    exec: (query) => serialize(() => execute(sqlite3, db, query)),
    close: () =>
      serialize(async () => {
        await sqlite3.close(db);
        await vfs?.close();
      }),
  };
}

function isNotFound(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "NotFoundError";
}

async function removeOpfsDatabase(filename: string): Promise<void> {
  const directories = filename.split("/").filter(Boolean);
  const name = directories.pop();
  let directory = await navigator.storage.getDirectory();
  const ignoreNotFound = (error: unknown) => {
    if (!isNotFound(error)) throw error;
  };
  for (const segment of directories) {
    const child = await directory.getDirectoryHandle(segment).catch(ignoreNotFound);
    if (!child) return;
    directory = child;
  }
  for (const suffix of DATABASE_FILE_SUFFIXES) {
    await directory.removeEntry(`${name}${suffix}`).catch(ignoreNotFound);
  }
}

function removeIndexedDBDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Delete the database `openWaSqliteEngine` opens with these options: its OPFS file and
 * journals, or its IndexedDB database. Pass it as `destroy` to `startDBStorageWorker` to
 * enable `DBStorage.destroy`.
 */
export async function destroyWaSqliteDatabase(options: WaSqliteEngineOptions): Promise<void> {
  const vfs = options.vfs ?? "opfs";
  if (vfs === "indexeddb") await removeIndexedDBDatabase(options.filename);
  else if (vfs === "opfs") await removeOpfsDatabase(options.filename);
}
