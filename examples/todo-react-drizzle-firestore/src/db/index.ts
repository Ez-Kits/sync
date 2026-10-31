import { createSqlJsDBStorage } from "@ez-kits/sync-storage-sqljs";

/**
 * The local database of one account. Each account gets its own storage key and IndexedDB
 * snapshot, so accounts never share rows, outbox or checkpoints. Each tab starts a storage
 * worker; the workers of an account elect one leader that holds sql.js, and the other tabs'
 * queries and transactions run there.
 */
export function createTodoDBStorage(account: string) {
  return createSqlJsDBStorage({
    key: `ez-sync-todo:${account}`,
    engineOptions: { indexedDBName: `ez-sync-todo-sqljs:${account}` },
    worker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
  });
}
