import { expect, test, vi } from "vite-plus/test";
import {
  deleteVsUpdate,
  lastWriteWins,
  localWins,
  manualResolution,
  mergeFields,
  remoteWins,
  type ChangeBusEvent,
  type ChangeBusEventDataMap,
  type ConflictResolution,
} from "../src";
import type {
  ChangeBusEventDataMapFromCollectionConfigMap,
  CollectionConfig,
} from "@ez-kits/sync-client-core";

type TodoData = {
  todos: {
    create: { id: number; title: string; updatedAt?: number; done?: boolean };
    update: { id: number; title: string; updatedAt?: number; done?: boolean };
    delete: number;
    record: {
      id: number;
      title: string;
      updatedAt?: number;
      done?: boolean;
      version?: number | string | Date;
    };
  };
};

type ConfiguredTodo = CollectionConfig<
  "todos",
  {},
  { id: number; title: string },
  { title: string },
  { id: number; title: string; persistedVersion: number },
  "id"
>;

type ConfiguredTodoData = ChangeBusEventDataMapFromCollectionConfigMap<[ConfiguredTodo]>;

const remoteUpdate: ChangeBusEvent<TodoData> = {
  type: "update",
  collection: "todos",
  data: { id: 1, title: "remote", updatedAt: 20 },
};

test("localWins and remoteWins return their named resolution", () => {
  expect(localWins<TodoData>()({ remote: remoteUpdate, local: { id: 1, title: "local" } })).toBe(
    "local",
  );
  expect(remoteWins<TodoData>()({ remote: remoteUpdate, local: { id: 1, title: "local" } })).toBe(
    "remote",
  );
});

test("lastWriteWins compares numbers, strings, and dates with explicit ties and missing values", () => {
  const numeric = lastWriteWins<TodoData>({
    getLocalVersion: (local) => local?.version,
    getRemoteVersion: (remote) => (remote.type === "delete" ? undefined : remote.data.updatedAt),
    onMissingVersion: "remote",
    onTie: "local",
  });
  expect(numeric({ remote: remoteUpdate, local: { id: 1, title: "local", version: 21 } })).toBe(
    "local",
  );
  expect(numeric({ remote: remoteUpdate, local: { id: 1, title: "local", version: 19 } })).toBe(
    "remote",
  );
  expect(numeric({ remote: remoteUpdate, local: { id: 1, title: "local", version: 20 } })).toBe(
    "local",
  );
  expect(numeric({ remote: remoteUpdate, local: undefined })).toBe("remote");
  expect(
    numeric({ remote: remoteUpdate, local: { id: 1, title: "local", version: Number.NaN } }),
  ).toBe("remote");

  const lexical = lastWriteWins<TodoData>({
    getLocalVersion: (local) => local?.version,
    getRemoteVersion: () => "v2",
    onMissingVersion: "local",
    onTie: "remote",
  });
  expect(lexical({ remote: remoteUpdate, local: { id: 1, title: "local", version: "v10" } })).toBe(
    "remote",
  );

  const dates = lastWriteWins<TodoData>({
    getLocalVersion: (local) => local?.version,
    getRemoteVersion: () => new Date(30),
    onMissingVersion: "local",
    onTie: "remote",
  });
  expect(
    dates({
      remote: remoteUpdate,
      local: { id: 1, title: "local", version: new Date(Number.NaN) },
    }),
  ).toBe("local");

  const incompatible = lastWriteWins<TodoData>({
    getLocalVersion: () => 5,
    getRemoteVersion: () => "5",
    onMissingVersion: "local",
    onTie: "remote",
  });
  expect(incompatible({ remote: remoteUpdate, local: { id: 1, title: "local" } })).toBe("local");
});

test("mergeFields uses remote data as the base and invokes only configured field mergers", async () => {
  const merge = mergeFields<TodoData>({
    fields: {
      done: (local, remote) => Boolean(local) || Boolean(remote),
    },
    onMissingLocal: "remote",
    onRemoteDelete: "local",
  });
  const localRecord = { id: 1, title: "local", done: true, localOnly: "preserved" };
  expect(
    merge({
      remote: { ...remoteUpdate, data: { ...remoteUpdate.data, done: false } },
      local: localRecord,
    }),
  ).toEqual({
    data: {
      id: 1,
      title: "remote",
      updatedAt: 20,
      done: true,
      localOnly: "preserved",
    },
  });
  expect(merge({ remote: remoteUpdate, local: undefined })).toBe("remote");
  expect(
    merge({
      remote: { type: "delete", collection: "todos", id: 1 },
      local: { id: 1, title: "local" },
    }),
  ).toBe("local");
  expect(
    merge({
      remote: { ...remoteUpdate, data: null as never },
      local: { id: 1, title: "local" },
    }),
  ).toBe("remote");

  const specialFieldMerge = mergeFields<TodoData>({
    fields: Object.fromEntries([["__proto__", () => "merged"]]),
    onMissingLocal: "local",
    onRemoteDelete: "remote",
  });
  const result = await specialFieldMerge({
    remote: remoteUpdate,
    local: { id: 1, title: "local" },
  });
  if (
    typeof result !== "object" ||
    result === null ||
    !("data" in result) ||
    typeof result.data !== "object" ||
    result.data === null
  ) {
    throw new Error("Expected the configured field merge to return data");
  }
  expect(Object.hasOwn(result.data, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(result.data)).toBe(Object.prototype);
});

test("deleteVsUpdate applies explicit delete choices and defaults non-delete conflicts to remote", () => {
  const resolve = deleteVsUpdate<TodoData>({
    onRemoteDelete: "local",
    onMissingLocal: "local",
  });
  expect(
    resolve({
      remote: { type: "delete", collection: "todos", id: 1 },
      local: { id: 1, title: "local" },
    }),
  ).toBe("local");
  expect(resolve({ remote: remoteUpdate, local: undefined })).toBe("local");
  expect(resolve({ remote: remoteUpdate, local: { id: 1, title: "local" } })).toBe("remote");
});

test("manualResolution awaits an application decision and uses an explicit fallback", async () => {
  const onConflict = vi.fn(async () => ({ data: { id: 1, title: "reviewed" } }));
  const manual = manualResolution<TodoData>({ onConflict, fallback: "local" });
  await expect(manual({ remote: remoteUpdate, local: { id: 1, title: "local" } })).resolves.toEqual(
    {
      data: { id: 1, title: "reviewed" },
    },
  );
  expect(onConflict).toHaveBeenCalledWith({
    remote: remoteUpdate,
    local: { id: 1, title: "local" },
  });

  const pending = manualResolution<TodoData>({
    onConflict: () => undefined,
    fallback: "remote",
  });
  await expect(pending({ remote: remoteUpdate, local: { id: 1, title: "local" } })).resolves.toBe(
    "remote",
  );

  const failing = manualResolution<TodoData>({
    onConflict: () => {
      throw new Error("manual resolver failed");
    },
    fallback: "local",
  });
  await expect(failing({ remote: remoteUpdate, local: { id: 1, title: "local" } })).rejects.toThrow(
    "manual resolver failed",
  );
});

test("a built-in resolver can be assigned to the core ConflictResolution type", () => {
  const broadResolver: ConflictResolution<ChangeBusEventDataMap> = remoteWins();
  const typedResolver: ConflictResolution<TodoData> = lastWriteWins<TodoData>({
    getLocalVersion: (local) => local?.version,
    getRemoteVersion: () => 2,
    onMissingVersion: "local",
    onTie: "remote",
  });
  const collectionRecordResolver = lastWriteWins<ConfiguredTodoData>({
    getLocalVersion: (local) => local?.persistedVersion,
    getRemoteVersion: () => 2,
    onMissingVersion: "local",
    onTie: "remote",
  });
  type LegacyTodoData = {
    todos: {
      create: { id: number; updatedAt?: number };
      update: { id: number; updatedAt?: number };
      delete: number;
    };
  };
  const legacyResolver = lastWriteWins<LegacyTodoData>({
    getLocalVersion: (local) => local?.updatedAt,
    getRemoteVersion: () => 2,
    onMissingVersion: "local",
    onTie: "remote",
  });
  expect(broadResolver).toBeTypeOf("function");
  expect(typedResolver).toBeTypeOf("function");
  expect(collectionRecordResolver).toBeTypeOf("function");
  expect(legacyResolver).toBeTypeOf("function");
});
