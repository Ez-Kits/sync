import { createLocalStorageCheckpointStorage } from "@ez-kits/sync-client-core";
import { createSyncClientReact } from "@ez-kits/sync-client-react";
import {
  createTypeOrmDBAdapter,
  defineTypeormCollection,
} from "@ez-kits/sync-client-typeorm-adapter";
import "reflect-metadata";
import { DataSource } from "typeorm";
import { Post, SyncDirtyRecord, SyncEvent, User, UsersPosts } from "./entities/index.ts";

const schema = {
  users: User,
  posts: Post,
  usersPosts: UsersPosts,
};

export const dataSource = new DataSource({
  type: "sqljs",
  synchronize: true,
  location: "ez-sync-react-typeorm-example",
  autoSave: true,
  logging: false,
  entities: [User, Post, UsersPosts, SyncEvent, SyncDirtyRecord],
});

await dataSource.initialize();

const collection = defineTypeormCollection({
  name: "users",
  entity: User,
  primaryField: "id",
});

const { useLiveQuery } = createSyncClientReact({
  collections: [collection],
  // sql.js keeps a separate in-memory database per tab; TypeORM cannot forward queries
  // to another tab, so this demo runs as a single context.
  dbAdapter: createTypeOrmDBAdapter({
    db: dataSource,
    collections: [collection],
    schema,
    eventEntity: SyncEvent,
    dirtyRecordEntity: SyncDirtyRecord,
  }),
  checkpointStorage: createLocalStorageCheckpointStorage({
    key: "checkpoint",
    serializer: (checkpoint: string) => JSON.stringify(checkpoint),
    deserializer: (value: string) => JSON.parse(value) as string,
  }),
});

export function useTestUseLiveQuery() {
  const { data } = useLiveQuery({
    query: (db, entityMap) => db.getRepository(entityMap.posts).find(),
  });
  return data;
}
