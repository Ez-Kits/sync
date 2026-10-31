import type { BaseDBAdapter, CollectionConfig, SyncClient } from "@ez-kits/sync-client-core";
import type { ComponentType, ReactNode } from "react";
import { expectTypeOf, test } from "vite-plus/test";
import { createSyncClientReact, type UseLiveQueryResult } from "../../src";

interface Todo {
  id: number;
  title: string;
}
interface Checkpoint {
  cursor: string;
}
type Collections = [
  CollectionConfig<"todos", unknown, Partial<Todo>, Omit<Todo, "id">, Todo, "id", Checkpoint>,
  CollectionConfig<"tags", unknown, { name: string }, { name: string }, { name: string }, "name">,
];
interface QueryBuilder {
  readonly kind: "query-builder";
}
type DB = BaseDBAdapter<Collections, QueryBuilder, { todos: "todos-table"; tags: "tags-table" }>;

declare const collections: Collections;
declare const dbAdapter: DB;
const react = createSyncClientReact({ collections, dbAdapter });

test("createSyncClientReact keeps the client fully typed", () => {
  expectTypeOf(react).not.toBeAny();
  expectTypeOf(react.useLiveQuery).not.toBeAny();
  // Without a typed serializer the checkpoint type comes from the collections.
  expectTypeOf(react.syncClient).toEqualTypeOf<SyncClient<Collections, DB>>();
  expectTypeOf(react.useSyncClient).returns.toEqualTypeOf<SyncClient<Collections, DB>>();
  expectTypeOf(react.SyncClientProvider).toEqualTypeOf<ComponentType<{ children: ReactNode }>>();
});

test("useLiveQuery infers the query result and adapter types", () => {
  const result = react.useLiveQuery({
    collections: ["todos"],
    query: async (qb, schema) => {
      expectTypeOf(qb).toEqualTypeOf<QueryBuilder>();
      expectTypeOf(schema.todos).toEqualTypeOf<"todos-table">();
      return [] as Todo[];
    },
  });
  expectTypeOf(result).toEqualTypeOf<UseLiveQueryResult<Todo[]>>();
  expectTypeOf(result.data).toEqualTypeOf<Todo[] | undefined>();
  expectTypeOf(result.error).toEqualTypeOf<Error | undefined>();
  expectTypeOf(result.isPending).toEqualTypeOf<boolean>();

  react.useLiveQuery({
    // @ts-expect-error live queries only watch known collections
    collections: ["projects"],
    query: () => 1,
  });
});

test("options are validated like createSyncClient", () => {
  createSyncClientReact({
    collections,
    // @ts-expect-error the adapter must implement the DB adapter contract
    dbAdapter: { queryBuilder: dbAdapter.queryBuilder },
  });
  createSyncClientReact({
    collections,
    dbAdapter,
    // @ts-expect-error checkpoints always live in the adapter's local-change store
    checkpointStorage: { getCheckpoint: async () => undefined, saveCheckpoint: async () => {} },
  });
  const serialized = createSyncClientReact({
    collections,
    dbAdapter,
    checkpointSerializer: {
      serialize: (checkpoint: Checkpoint) => checkpoint.cursor,
      deserialize: (value: string): Checkpoint => ({ cursor: value }),
    },
  });
  expectTypeOf(serialized.syncClient).toEqualTypeOf<SyncClient<Collections, DB, Checkpoint>>();
});
