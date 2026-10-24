import { createLocalStorageCheckpointStorage, createSyncClient } from "@ez-kits/sync-client-core";
import {
  createDrizzleDBAdapter,
  defineDrizzleCollection,
} from "@ez-kits/sync-client-drizzle-adapter";
import { defineRelations } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/sqlite-proxy";

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
  syncAdapter: {
    pull: (options) => {
      options.commitChanges({
        changes: [],
        checkpoint: {
          users: "121",
        },
      });
    },
    push: (options) => {
      console.log(options.commitChanges);
    },
  },
});

const syncClient = createSyncClient({
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
  syncAdapter: {
    pull: (options) => {
      options.commitChanges({
        changes: [],
        checkpoint: {
          users: "121",
        },
      });
    },
    push: (options) => {
      console.log(options.commitChanges);
    },
  },
});

syncClient.liveQuery({
  query: (db) =>
    db.query.posts.findMany({
      with: {
        author: false,
      },
    }),
  onData: (data) => {
    console.log(data);
  },
});
