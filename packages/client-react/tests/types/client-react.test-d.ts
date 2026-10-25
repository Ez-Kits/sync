import type {
  AtomicLocalChangeStore,
  AtomicLocalMutationStorage,
  BaseDBAdapter,
  CollectionConfig,
  ICheckpointStorage,
  SyncClient,
} from "@ez-kits/sync-client-core";
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
declare const storage: AtomicLocalMutationStorage<DB, AtomicLocalChangeStore>;
declare const checkpointStorage: ICheckpointStorage<"todos" | "tags", Checkpoint>;

const react = createSyncClientReact({ collections, storage, checkpointStorage });

test("createSyncClientReact keeps the client fully typed", () => {
  expectTypeOf(react).not.toBeAny();
  expectTypeOf(react.useLiveQuery).not.toBeAny();
  expectTypeOf(react.syncClient).toEqualTypeOf<SyncClient<Collections, DB, Checkpoint>>();
  expectTypeOf(react.useSyncClient).returns.toEqualTypeOf<
    SyncClient<Collections, DB, Checkpoint>
  >();
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
    // @ts-expect-error storage must be a branded atomic pair
    storage: { dbAdapter: storage.dbAdapter, localChangeStore: storage.localChangeStore },
    checkpointStorage,
  });
});
