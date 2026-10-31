import type * as Core from "@ez-kits/sync-client-core";
import {
  createSyncClient,
  type BaseDBAdapter,
  type ChangeBusEventDataMapFromCollectionConfigMap,
  type CollectionConfig,
} from "@ez-kits/sync-client-core";
import { expectTypeOf, test } from "vite-plus/test";
import {
  deleteVsUpdate,
  lastWriteWins,
  localWins,
  manualResolution,
  mergeFields,
  remoteWins,
  type ChangeBusEvent,
  type ChangeBusEventDataMap,
  type ConflictContext,
  type ConflictDecision,
  type ConflictResolution,
} from "../../src";

interface Todo {
  id: number;
  title: string;
  updatedAt: Date;
}
type TodoConfig = CollectionConfig<"todos", unknown, Partial<Todo>, Todo, Todo, "id">;
type DataMap = ChangeBusEventDataMapFromCollectionConfigMap<[TodoConfig]>;
declare const todos: TodoConfig;
declare const db: BaseDBAdapter<[TodoConfig], unknown, { todos: unknown }>;

test("re-exported core types are identical", () => {
  expectTypeOf<ChangeBusEventDataMap>().toEqualTypeOf<Core.ChangeBusEventDataMap>();
  expectTypeOf<ChangeBusEvent<DataMap>>().toEqualTypeOf<Core.ChangeBusEvent<DataMap>>();
  expectTypeOf<ConflictResolution<DataMap>>().toEqualTypeOf<Core.ConflictResolution<DataMap>>();
});

test("conflict context and decisions are exact", () => {
  expectTypeOf<ConflictContext<DataMap>["local"]>().toEqualTypeOf<Todo | undefined>();
  expectTypeOf<ConflictContext<DataMap>["remote"]>().toEqualTypeOf<ChangeBusEvent<DataMap>>();
  expectTypeOf<ConflictDecision>().toEqualTypeOf<"local" | "remote" | { data: unknown }>();
});

test("policies return a resolution for the requested data map", () => {
  expectTypeOf(localWins<DataMap>()).toEqualTypeOf<ConflictResolution<DataMap>>();
  expectTypeOf(remoteWins<DataMap>()).toEqualTypeOf<ConflictResolution<DataMap>>();
  expectTypeOf(
    mergeFields<DataMap>({ fields: {}, onMissingLocal: "remote", onRemoteDelete: "remote" }),
  ).toEqualTypeOf<ConflictResolution<DataMap>>();
  expectTypeOf(
    deleteVsUpdate<DataMap>({ onMissingLocal: "remote", onRemoteDelete: "local" }),
  ).toEqualTypeOf<ConflictResolution<DataMap>>();
  expectTypeOf(
    manualResolution<DataMap>({ onConflict: () => undefined, fallback: "local" }),
  ).toEqualTypeOf<ConflictResolution<DataMap>>();
});

test("lastWriteWins version getters are typed from the data map", () => {
  lastWriteWins<DataMap>({
    getLocalVersion: (local) => {
      expectTypeOf(local).toEqualTypeOf<Todo | undefined>();
      return local?.updatedAt;
    },
    getRemoteVersion: (remote) => {
      expectTypeOf(remote).toEqualTypeOf<ChangeBusEvent<DataMap>>();
      return remote.type === "delete" ? undefined : remote.data.updatedAt;
    },
    onMissingVersion: "remote",
    onTie: "local",
  });

  lastWriteWins<DataMap>({
    getLocalVersion: () => 1,
    getRemoteVersion: () => 1,
    onMissingVersion: "remote",
    // @ts-expect-error ties resolve to local or remote only
    onTie: "merge",
  });
  lastWriteWins<DataMap>({
    // @ts-expect-error versions must be number, string, or Date
    getLocalVersion: () => true,
    getRemoteVersion: () => 1,
    onMissingVersion: "remote",
    onTie: "local",
  });
});

test("policies stored in a variable first fit any client", () => {
  const merge = mergeFields({ fields: {}, onMissingLocal: "remote", onRemoteDelete: "remote" });
  const latest = lastWriteWins({
    getLocalVersion: () => 1,
    getRemoteVersion: () => 1,
    onMissingVersion: "remote",
    onTie: "local",
  });
  const policies: ConflictResolution<DataMap>[] = [
    merge,
    latest,
    localWins(),
    deleteVsUpdate({ onMissingLocal: "remote", onRemoteDelete: "local" }),
  ];
  expectTypeOf(policies).items.toEqualTypeOf<ConflictResolution<DataMap>>();
});

test("policies passed inline to a client infer its collection types", () => {
  createSyncClient({
    collections: [todos],
    dbAdapter: db,
    resolveConflict: lastWriteWins({
      getLocalVersion: (local) => {
        expectTypeOf(local).toEqualTypeOf<Todo | undefined>();
        return local?.updatedAt;
      },
      getRemoteVersion: () => 1,
      onMissingVersion: "remote",
      onTie: "local",
    }),
  });
  const policy = mergeFields({ fields: {}, onMissingLocal: "remote", onRemoteDelete: "remote" });
  createSyncClient({ collections: [todos], dbAdapter: db, resolveConflict: policy });
});
