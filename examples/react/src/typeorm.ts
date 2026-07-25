import { createLocalStorageCheckpointStorage } from "@ez-kits/sync-client-core";
import { createSyncClientReact } from "@ez-kits/sync-client-react";
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

const { useLiveQuery } = createSyncClientReact({
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

export function useTestUseLiveQuery() {
  const { data } = useLiveQuery({
    query: (db, entityMap) => db.getRepository(entityMap.posts).find(),
  });
  return data;
}
