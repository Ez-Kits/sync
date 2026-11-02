import type { DBEngine, DBQuery, DBQueryResult } from "@ez-kits/sync-client-core";
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import type { PGliteEngineOptions } from "./options";

export interface OpenPGliteEngineOptions extends PGliteEngineOptions {
  /** Extra PGlite options (extensions, debug, ...). */
  pglite?: PGliteOptions;
}

export interface PGliteEngine extends DBEngine {
  /** The underlying PGlite instance, for migrations or tooling. */
  readonly database: PGlite;
}

async function execute(pg: PGlite, query: DBQuery): Promise<DBQueryResult> {
  // Without parameters every statement runs, so migrations can be one script.
  if (query.method === "run" && query.params.length === 0) {
    await pg.exec(query.sql);
    return { rows: [] };
  }
  const result = await pg.query(query.sql, query.params, { rowMode: query.rowMode ?? "array" });
  if (query.method === "run") return { rows: [] };
  const rows = query.method === "get" ? result.rows.slice(0, 1) : result.rows;
  return { rows, affectedRows: result.affectedRows };
}

/** Open PGlite in this (leader) worker. PGlite persists `idb://` data on its own. */
export async function openPGliteEngine(
  options: OpenPGliteEngineOptions = {},
): Promise<PGliteEngine> {
  const pg = await PGlite.create(options.dataDir, options.pglite);
  return {
    database: pg,
    exec: (query) => execute(pg, query),
    close: () => pg.close(),
  };
}

type StorageHost = {
  indexedDB?: IDBFactory;
  navigator?: { storage?: { getDirectory?(): Promise<FileSystemDirectoryHandle> } };
};

function deleteIndexedDB(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function removeOpfsDirectory(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  const segments = path.split("/").filter(Boolean);
  const last = segments.pop();
  if (last === undefined) return;
  try {
    let directory = root;
    for (const segment of segments) directory = await directory.getDirectoryHandle(segment);
    await directory.removeEntry(last, { recursive: true });
  } catch (error) {
    // Already gone.
    if ((error as { name?: unknown }).name !== "NotFoundError") throw error;
  }
}

/**
 * Delete the database `openPGliteEngine` opens with these options: an `idb://` data dir's
 * IndexedDB database, or an `opfs-ahp://` data dir's OPFS directory. In-memory databases have
 * nothing to delete; remove a file-system data dir yourself. Pass it as `destroy` to
 * `startDBStorageWorker` to enable `DBStorage.destroy`.
 */
export async function destroyPGliteDatabase(
  options: PGliteEngineOptions = {},
  host: StorageHost = globalThis as StorageHost,
): Promise<void> {
  const { dataDir } = options;
  if (dataDir === undefined || dataDir.startsWith("memory://")) return;
  if (dataDir.startsWith("idb://")) {
    // PGlite's IndexedDB file system is named after its mount point.
    await deleteIndexedDB(host.indexedDB!, `/pglite/${dataDir.slice("idb://".length)}`);
    return;
  }
  if (dataDir.startsWith("opfs-ahp://")) {
    const root = await host.navigator!.storage!.getDirectory!();
    await removeOpfsDirectory(root, dataDir.slice("opfs-ahp://".length));
    return;
  }
  throw new Error(
    `destroyPGliteDatabase cannot delete "${dataDir}": remove the directory yourself.`,
  );
}
