import { createLocalStorageCheckpointStorage, createSyncClient } from "@ez-kits/sync-client-core";
import {
  createTypeOrmDBAdapter,
  defineTypeormCollection,
} from "@ez-kits/sync-client-typeorm-adapter";
import "reflect-metadata";
import { DataSource } from "typeorm";
import { Post, User, UsersPosts } from "./entities/index.ts";

const schema = {
  users: User,
  posts: Post,
  usersPosts: UsersPosts,
};

export const dataSource = new DataSource({
  type: "sqljs",
  synchronize: true,
  logging: false,
  entities: [User, Post, UsersPosts],
});

await dataSource.initialize();

const collection = defineTypeormCollection({
  name: "users",
  entity: User,
  primaryField: "id",
});

const syncClient = createSyncClient({
  collections: [collection],
  dbAdapter: (collections) =>
    createTypeOrmDBAdapter({
      db: dataSource,
      collections,
      schema,
    }),
  checkpointStorage: createLocalStorageCheckpointStorage({
    key: "checkpoint",
    serializer: (checkpoint: string) => JSON.stringify(checkpoint),
    deserializer: (value: string) => JSON.parse(value) as string,
  }),
});

syncClient.liveQuery({
  query: (db, entityMap) => db.getRepository(entityMap.posts).find(),
  onData: (data) => {
    console.log(data);
  },
});
