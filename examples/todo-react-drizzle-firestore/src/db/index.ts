import { createWaSqliteDBStorage } from "@ez-kits/sync-client-storage-wa-sqlite";
import { todoVfs } from "./vfs.ts";

/**
 * The local database of one account. Each account gets its own storage key and database file,
 * so accounts never share rows, outbox or checkpoints. Each tab starts a storage worker; the
 * workers of an account elect one leader that holds wa-sqlite, and the other tabs' queries
 * and transactions run there.
 */
export function createTodoDBStorage(account: string) {
  return createWaSqliteDBStorage({
    key: `ez-sync-todo:${account}`,
    engineOptions: { filename: `ez-sync-todo-${account}.sqlite3`, vfs: todoVfs },
    worker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
  });
}
