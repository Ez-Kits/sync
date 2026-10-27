import {
  createDrizzleStorage,
  defineDrizzleCollection,
} from "@ez-kits/sync-client-drizzle-adapter";
import { createLocalStorageCheckpointStorage } from "@ez-kits/sync-client-core";
import { createSyncClientReact } from "@ez-kits/sync-client-react";
import { defineRelations } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
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

const syncEvents = sqliteTable("ez_sync_events", {
  id: text().primaryKey(),
  type: text().notNull(),
  collection: text().notNull(),
  data: text({ mode: "json" }),
  recordId: text().notNull(),
  createdAt: integer().notNull(),
});

const dirtyRecords = sqliteTable(
  "ez_sync_dirty_records",
  {
    collection: text().notNull(),
    recordId: text().notNull(),
    state: text().notNull(),
    updatedAt: integer().notNull(),
  },
  (table) => [uniqueIndex("ez_sync_dirty_record_key").on(table.collection, table.recordId)],
);

const schema = {
  users,
  posts,
  usersPosts,
  syncEvents,
  dirtyRecords,
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

export const db = drizzle(
  {
    all: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
    run: () => Promise.resolve(undefined),
  },
  { relations },
);

const collection = defineDrizzleCollection({
  name: "users",
  table: users,
});

const { useLiveQuery } = createSyncClientReact({
  collections: [collection],
  storage: createDrizzleStorage({
    sharing: "shared",
    coordinateTabs: false,
    open: () => ({ database: db }),
    collections: [collection],
    schema,
    localChangeTables: { events: syncEvents, dirtyRecords },
  }),
  checkpointStorage: createLocalStorageCheckpointStorage({
    key: "checkpoint",
    serializer: (checkpoint: string) => JSON.stringify(checkpoint),
    deserializer: (value: string) => JSON.parse(value) as string,
  }),
});

// This query-only proxy is a placeholder; replace it with durable transactional
// storage before using local collection mutations.
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
