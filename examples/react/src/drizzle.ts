import {
  createDrizzleDBAdapter,
  defineDrizzleCollection,
} from "@ez-kits/sync-client-drizzle-adapter";
import { defineRelations } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { createSyncClientReact } from "@ez-kits/sync-client-react";
import { createLocalStorageCheckpointStorage } from "@ez-kits/sync-client-core";

const users = sqliteTable(
  "users",
  {
    id: integer().primaryKey(),
    name: text().notNull(),
    email: text(),
  },
  (table) => [index("name_email_index").on(table.name, table.email)],
);

const posts = sqliteTable("posts", {
  id: integer().primaryKey(),
  title: text(),
  content: text(),
});

const usersPosts = sqliteTable("users_posts", {
  userId: integer().references(() => users.id),
  postId: integer().references(() => posts.id),
});

const schema = {
  users,
  posts,
  usersPosts,
};

const relations = defineRelations(schema, (relation) => {
  return {
    users: {
      posts: relation.many.posts({
        from: relation.users.id.through(relation.usersPosts.userId),
        to: relation.posts.id.through(relation.usersPosts.postId),
      }),
    },
    posts: {
      author: relation.many.users({
        from: relation.posts.id.through(relation.usersPosts.postId),
        to: relation.users.id.through(relation.usersPosts.userId),
      }),
    },
  };
});

export const db = drizzle(() => Promise.resolve({ rows: [] }), {
  schema,
  relations,
});

const collection = defineDrizzleCollection({
  name: "users",
  table: users,
});

const { useLiveQuery } = createSyncClientReact({
  collections: [collection],
  dbAdapter: (collections) =>
    createDrizzleDBAdapter({
      db,
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
    query: (db) =>
      db.query.posts.findMany({
        with: {
          author: false,
        },
      }),
  });
  return data;
}
