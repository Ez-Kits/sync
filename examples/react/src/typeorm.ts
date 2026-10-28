import {
  createLocalDBStorage,
  createLocalStorageCheckpointStorage,
} from "@ez-kits/sync-client-core";
import { createSyncClientReact } from "@ez-kits/sync-client-react";
import { defineTypeormCollection } from "@ez-kits/sync-client-typeorm-adapter";
import { createTypeOrmSqliteDBAdapter } from "@ez-kits/sync-client-typeorm-adapter/sqlite";
import { openSqlJsEngine } from "@ez-kits/sync-storage-sqljs/worker";
import "reflect-metadata";
import { Post, User, UsersPosts } from "./entities/index.ts";

// sql.js in this context only (persisted to IndexedDB); see the todo examples for a
// database shared by every tab through a storage worker.
const dbStorage = createLocalDBStorage({
  dialect: "sqlite",
  open: () => openSqlJsEngine({ indexedDB: "ez-sync-react-typeorm-example" }),
});

const collection = defineTypeormCollection({
  name: "users",
  entity: User,
  primaryField: "id",
});

const { useLiveQuery } = createSyncClientReact({
  collections: [collection],
  dbAdapter: createTypeOrmSqliteDBAdapter({
    dbStorage,
    collections: [collection],
    // Entities that are not collections, and TypeORM creating the app's own tables.
    entities: [Post, UsersPosts],
    dataSourceOptions: { synchronize: true },
  }),
  checkpointStorage: createLocalStorageCheckpointStorage({
    key: "checkpoint",
    serializer: (checkpoint: string) => JSON.stringify(checkpoint),
    deserializer: (value: string) => JSON.parse(value) as string,
  }),
});

export function useTestUseLiveQuery() {
  const { data } = useLiveQuery({
    query: (db) => db.getRepository(Post).find(),
  });
  return data;
}
