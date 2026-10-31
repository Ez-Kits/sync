import { createSqlJsDBStorage } from "@ez-kits/sync-storage-sqljs";

/**
 * The local database. Each tab starts a storage worker; the workers elect one leader
 * that holds sql.js, and the other tabs' queries and transactions run there.
 */
export const dbStorage = createSqlJsDBStorage({
  key: "ez-sync-todo",
  engineOptions: { indexedDBName: "ez-sync-todo-sqljs" },
  worker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
});
