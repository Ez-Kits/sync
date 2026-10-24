import { beforeEach, expect, test, vi } from "vite-plus/test";

const sdk = vi.hoisted(() => ({
  firestoreCallbacks: [] as Array<(snapshot: any) => void>,
  firestoreUnsubscribes: [] as Array<ReturnType<typeof vi.fn>>,
  firestoreSets: [] as unknown[][],
  firestoreCommits: [] as Array<ReturnType<typeof vi.fn>>,
  rtdbCallbacks: {} as Record<string, Array<(snapshot: any) => void>>,
  rtdbOffs: [] as unknown[][],
  updates: [] as unknown[][],
  failCommit: false,
}));

vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, path: string) => ({ path }),
  query: (ref: unknown, ...constraints: unknown[]) => ({ ref, constraints }),
  doc: (_db: unknown, path: string, id: string) => ({ path: `${path}/${id}`, id }),
  onSnapshot: (_source: unknown, _options: unknown, callback: (snapshot: any) => void) => {
    sdk.firestoreCallbacks.push(callback);
    const unsubscribe = vi.fn();
    sdk.firestoreUnsubscribes.push(unsubscribe);
    return unsubscribe;
  },
  writeBatch: () => {
    const batch = {
      set: vi.fn((ref: unknown, data: unknown, options?: unknown) =>
        sdk.firestoreSets.push([ref, data, options]),
      ),
      commit: vi.fn(async () => {
        if (sdk.failCommit) throw new Error("commit failed");
      }),
    };
    sdk.firestoreCommits.push(batch.commit);
    return batch;
  },
}));

vi.mock("firebase/database", () => ({
  ref: (_db: unknown, path?: string) => ({ path: path ?? "" }),
  query: (target: unknown, ...constraints: unknown[]) => ({ target, constraints }),
  onChildAdded: (target: unknown, callback: (snapshot: any) => void) => {
    (sdk.rtdbCallbacks.added ??= []).push(callback);
    return callback;
  },
  onChildChanged: (target: unknown, callback: (snapshot: any) => void) => {
    (sdk.rtdbCallbacks.changed ??= []).push(callback);
    return callback;
  },
  onChildRemoved: (target: unknown, callback: (snapshot: any) => void) => {
    (sdk.rtdbCallbacks.removed ??= []).push(callback);
    return callback;
  },
  off: (...args: unknown[]) => {
    sdk.rtdbOffs.push(args);
  },
  update: async (...args: unknown[]) => {
    sdk.updates.push(args);
    if (sdk.failCommit) throw new Error("update failed");
  },
}));

import { createFirestoreCollectionSyncAdapter, createFirestoreSyncAdapter } from "../src/firestore";
import { defineFirestoreCollectionSyncAdapterConfig } from "../src/firestore/define-collection-sync-adapter-config";
import {
  createRealtimeDBCollectionSyncAdapter,
  createRealtimeDBSyncAdapter,
} from "../src/realtime-db";
import { defineRealtimeDBCollectionSyncAdapterConfig } from "../src/realtime-db/define-collection-sync-adapter-config";
import { collectionNameFromPath } from "../src/shared/collection-name";

const collection = { name: "todos", primaryField: "id", adapterConfig: {} };
const docSnapshot = (id: string, value: unknown) => ({
  id,
  key: id,
  data: () => value,
  val: () => value,
});

beforeEach(() => {
  sdk.firestoreCallbacks.length = 0;
  sdk.firestoreUnsubscribes.length = 0;
  sdk.firestoreSets.length = 0;
  sdk.firestoreCommits.length = 0;
  sdk.rtdbCallbacks = {};
  sdk.rtdbOffs.length = 0;
  sdk.updates.length = 0;
  sdk.failCommit = false;
});

test("collection name helper handles nested slash paths and rejects empty paths", () => {
  expect(collectionNameFromPath("/users/1/todos/")).toBe("todos");
  expect(() => collectionNameFromPath("///")).toThrow("Unable to derive collectionName");
});

test("provider config helpers preserve configured names and collection adapters derive path names", () => {
  expect(
    defineFirestoreCollectionSyncAdapterConfig({
      collectionConfig: collection,
      collectionPath: "ignored",
      createCheckpoint: () => 1,
    } as never).collectionName,
  ).toBe("todos");
  expect(
    defineRealtimeDBCollectionSyncAdapterConfig({
      collectionConfig: collection,
      collectionPath: "ignored",
      createCheckpoint: () => 1,
    } as never).collectionName,
  ).toBe("todos");
  const firestore = createFirestoreCollectionSyncAdapter({
    db: {} as never,
    collectionPath: "users/7/tasks",
    createCheckpoint: () => 1,
  } as never);
  void firestore.pull({ commitChanges: vi.fn() } as never);
  expect(sdk.firestoreCallbacks).toHaveLength(1);
  void createRealtimeDBCollectionSyncAdapter({
    db: {} as never,
    collectionPath: "users/7/tasks",
    createCheckpoint: () => 1,
  } as never).pull({ commitChanges: vi.fn() } as never);
  expect(sdk.rtdbCallbacks.added).toHaveLength(1);
});

test("Firestore pull maps create, update, removed and tombstone events, advances checkpoint, and unsubscribes", () => {
  const makeConstraints = vi.fn(({ checkpoint }) => (checkpoint ? ["incremental"] : []));
  const adapter = createFirestoreSyncAdapter({
    db: {} as never,
    includeMetadataChanges: true,
    collections: [
      {
        collectionName: "todos",
        collectionPath: "todos",
        createCheckpoint: () => "fallback",
        createPullCheckpoint: ({ previousCheckpoint }: any) => `${previousCheckpoint ?? "start"}!`,
        buildPullQueryConstraints: makeConstraints,
      },
    ],
  } as never);
  const commitChanges = vi.fn();
  const cleanup = adapter.pull({
    checkpoint: { todos: "old" },
    commitChanges,
  } as never) as () => void;
  const added = docSnapshot("1", { id: "1", title: "a" });
  const changed = docSnapshot("2", { id: "2", title: "b" });
  const tombstone = docSnapshot("3", { deleted: true });
  const removed = docSnapshot("4", {});
  sdk.firestoreCallbacks[0]!({
    docChanges: () => [
      { type: "added", doc: added },
      { type: "modified", doc: changed },
      { type: "modified", doc: tombstone },
      { type: "removed", doc: removed },
    ],
  });
  expect(commitChanges).toHaveBeenCalledWith(
    expect.objectContaining({
      changes: [
        { type: "create", collection: "todos", data: { id: "1", title: "a" } },
        { type: "update", collection: "todos", data: { id: "2", title: "b" } },
        { type: "delete", collection: "todos", id: "3" },
        { type: "delete", collection: "todos", id: "4" },
      ],
      checkpoint: { todos: "old!" },
    }),
  );
  expect(makeConstraints).toHaveBeenCalledWith({ checkpoint: "old" });
  cleanup();
  expect(sdk.firestoreUnsubscribes[0]).toHaveBeenCalledOnce();
});

test("Firestore pull uses custom mappings, defaults, and ignores empty snapshots", () => {
  const isDeleted = vi.fn((raw: any) => raw.gone === true);
  const adapter = createFirestoreCollectionSyncAdapter({
    db: {} as never,
    collectionName: "todos",
    collectionPath: "todos",
    includeMetadataChanges: true,
    createCheckpoint: () => "cp",
    deserializeCreate: (raw: any) => ({ ...raw, mapped: true }),
    deserializeUpdate: (raw: any) => ({ ...raw, mapped: true }),
    deserializeDeleteId: ({ snapshot }: any) => `custom-${snapshot.id}`,
    isDeleted,
    buildPullQueryConstraints: () => ["where"],
  } as never);
  const commit = vi.fn();
  void adapter.pull({ commitChanges: commit } as never);
  sdk.firestoreCallbacks[0]!({ docChanges: () => [] });
  expect(commit).not.toHaveBeenCalled();
  sdk.firestoreCallbacks[0]!({
    docChanges: () => [
      { type: "added", doc: docSnapshot("x", { id: "x" }) },
      { type: "added", doc: docSnapshot("y", { gone: true }) },
      { type: "modified", doc: docSnapshot("z", { id: "z" }) },
      { type: "removed", doc: docSnapshot("w", {}) },
    ],
  });
  expect(commit.mock.calls[0]?.[0].changes).toEqual([
    { type: "create", collection: "todos", data: { id: "x", mapped: true } },
    { type: "delete", collection: "todos", id: "custom-y" },
    { type: "update", collection: "todos", data: { id: "z", mapped: true } },
    { type: "delete", collection: "todos", id: "custom-w" },
  ]);
  expect(isDeleted).toHaveBeenCalled();
});

test("Firestore pull covers unfiltered defaults, empty document data, and default checkpoint fallback", () => {
  const adapter = createFirestoreSyncAdapter({
    db: {} as never,
    collections: [
      { collectionName: "todos", collectionPath: "todos", createCheckpoint: () => "fallback" },
    ],
  } as never);
  const commit = vi.fn();
  void adapter.pull({ commitChanges: commit } as never);
  sdk.firestoreCallbacks[0]!({
    docChanges: () => [
      { type: "added", doc: { ...docSnapshot("x", undefined), data: () => undefined } },
      { type: "modified", doc: docSnapshot("y", { id: "y" }) },
      { type: "removed", doc: docSnapshot("z", {}) },
    ],
  });
  expect(commit).toHaveBeenCalledWith(
    expect.objectContaining({
      changes: [
        { type: "create", collection: "todos", data: {} },
        { type: "update", collection: "todos", data: { id: "y" } },
        { type: "delete", collection: "todos", id: "z" },
      ],
      checkpoint: { todos: "fallback" },
    }),
  );
});

test("Firestore push serializes events, skips unknown collections, batches at 500, and rejects failed commits", async () => {
  const adapter = createFirestoreSyncAdapter({
    db: {} as never,
    collections: [
      {
        collectionName: "todos",
        collectionPath: "todos",
        createCheckpoint: () => 1,
        serializeCreate: (data: any) => ({ ...data, remote: true }),
        serializeUpdate: (data: any) => data,
        serializeDelete: () => ({ deleted: true }),
        resolveDocumentId: (e: any) => (e.type === "delete" ? "deleted" : String(e.data.id)),
      },
    ],
  } as never);
  const commit = vi.fn();
  await adapter.push({ events: [], commitChanges: commit } as never);
  expect(sdk.firestoreCommits).toHaveLength(1);
  expect(sdk.firestoreCommits[0]).not.toHaveBeenCalled();
  const events = Array.from({ length: 501 }, (_, i) => ({
    type: "create",
    collection: "todos",
    data: { id: String(i) },
  }));
  events.push({ type: "create", collection: "unknown", data: { id: "skip" } });
  await adapter.push({ events, commitChanges: commit } as never);
  expect(sdk.firestoreCommits).toHaveLength(3);
  expect(sdk.firestoreSets).toHaveLength(501);
  expect(commit).toHaveBeenCalledOnce();
  const pushed = [
    { type: "update", collection: "todos", data: { id: "u" } },
    { type: "delete", collection: "todos", id: "d" },
  ];
  await adapter.push({ events: pushed, commitChanges: commit } as never);
  expect(sdk.firestoreSets.at(-2)?.[2]).toEqual({ merge: true });
  expect(sdk.firestoreSets.at(-1)?.[1]).toEqual({ deleted: true });
  sdk.failCommit = true;
  await expect(
    adapter.push({ events: [pushed[0]], commitChanges: commit } as never),
  ).rejects.toThrow("commit failed");
});

test("Firestore default push mappings create generated IDs and soft-delete documents", async () => {
  const adapter = createFirestoreCollectionSyncAdapter({
    db: {} as never,
    collectionName: "todos",
    collectionPath: "todos",
    createCheckpoint: () => 1,
  } as never);
  const commit = vi.fn();
  await adapter.push({
    events: [
      { type: "create", collection: "todos", data: { id: "one" } },
      { type: "update", collection: "todos", data: { title: "two" } },
      { type: "delete", collection: "todos", id: "three" },
    ],
    commitChanges: commit,
  } as never);
  expect(sdk.firestoreSets[0]?.[1]).toEqual({ id: "one" });
  const generatedRecord = sdk.firestoreSets[1]?.[0] as any;
  expect(generatedRecord).toBeDefined();
  expect(generatedRecord.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(sdk.firestoreSets[2]?.[0]).toEqual({ path: "todos/three", id: "three" });
  expect(sdk.firestoreSets[2]?.[1]).toMatchObject({ deleted: true, deletedAt: expect.any(Number) });
});

test("Realtime Database pull maps all child event forms and removes listeners", () => {
  const adapter = createRealtimeDBSyncAdapter({
    db: {} as never,
    collections: [
      {
        collectionName: "todos",
        collectionPath: "todos",
        createCheckpoint: () => "fallback",
        buildRealtimePullQuery: () => ({}) as never,
        createPullCheckpoint: ({ previousCheckpoint }: any) => `${previousCheckpoint ?? "first"}!`,
      },
    ],
  } as never);
  const commit = vi.fn();
  const cleanup = adapter.pull({
    checkpoint: { todos: "old" },
    commitChanges: commit,
  } as never) as () => void;
  const added = docSnapshot("a", { id: "a" });
  const changed = docSnapshot("b", { id: "b" });
  const tombstone = docSnapshot("d", { deleted: true });
  const removed = docSnapshot("c", {});
  sdk.rtdbCallbacks.added![0]!(added);
  sdk.rtdbCallbacks.added![0]!(tombstone);
  sdk.rtdbCallbacks.changed![0]!(changed);
  sdk.rtdbCallbacks.changed![0]!(docSnapshot("e", { deleted: true }));
  sdk.rtdbCallbacks.removed![0]!(removed);
  expect(commit.mock.calls.map(([call]) => call.changes[0])).toEqual([
    { type: "create", collection: "todos", data: { id: "a" } },
    { type: "delete", collection: "todos", id: "d" },
    { type: "update", collection: "todos", data: { id: "b" } },
    { type: "delete", collection: "todos", id: "e" },
    { type: "delete", collection: "todos", id: "c" },
  ]);
  expect(commit.mock.calls[4]?.[0].checkpoint).toEqual({ todos: "old!!!!!" });
  cleanup();
  expect(sdk.rtdbOffs).toHaveLength(3);
});

test("Realtime Database pull uses default listeners and custom mapping hooks", () => {
  const adapter = createRealtimeDBCollectionSyncAdapter({
    db: {} as never,
    collectionName: "todos",
    collectionPath: "todos",
    createCheckpoint: () => "cp",
    deserializeCreate: (raw: any) => ({ ...raw, created: true }),
    deserializeUpdate: (raw: any) => ({ ...raw, updated: true }),
    deserializeDeleteId: ({ snapshot }: any) => `custom-${snapshot.key}`,
    isDeleted: (raw: any) => raw?.gone === true,
  } as never);
  const commit = vi.fn();
  void adapter.pull({ commitChanges: commit } as never);
  sdk.rtdbCallbacks.added![0]!(docSnapshot("a", { id: "a" }));
  sdk.rtdbCallbacks.added![0]!(docSnapshot("d", { gone: true }));
  sdk.rtdbCallbacks.changed![0]!(docSnapshot("b", { id: "b" }));
  sdk.rtdbCallbacks.changed![0]!(docSnapshot("e", { gone: true }));
  sdk.rtdbCallbacks.removed![0]!(docSnapshot("c", {}));
  expect(commit.mock.calls.map(([call]) => call.changes[0])).toEqual([
    { type: "create", collection: "todos", data: { id: "a", created: true } },
    { type: "delete", collection: "todos", id: "custom-d" },
    { type: "update", collection: "todos", data: { id: "b", updated: true } },
    { type: "delete", collection: "todos", id: "custom-e" },
    { type: "delete", collection: "todos", id: "custom-c" },
  ]);
});

test("Realtime Database push merges update paths, replaces non-objects, skips unknown collections, and propagates errors", async () => {
  const adapter = createRealtimeDBCollectionSyncAdapter({
    db: {} as never,
    collectionName: "todos",
    collectionPath: "todos",
    createCheckpoint: () => 1,
    serializeCreate: (data: any) => ({ ...data, encoded: true }),
    serializeUpdate: () => ({ nested: { value: 2 } }),
    serializeDelete: () => "gone",
    resolveRecordId: (event: any) => String(event.data.id),
  } as never);
  const commit = vi.fn();
  await adapter.push({
    events: [
      { type: "create", collection: "todos", data: { id: "1" } },
      { type: "update", collection: "todos", data: { id: "1" } },
      { type: "delete", collection: "todos", id: "2" },
      { type: "create", collection: "other", data: { id: "3" } },
    ],
    commitChanges: commit,
  } as never);
  expect(sdk.updates[0]?.[1]).toEqual({
    "todos/1": { id: "1", encoded: true },
    "todos/1/nested": { value: 2 },
    "todos/2": "gone",
  });
  expect(commit).toHaveBeenCalledOnce();
  sdk.failCommit = true;
  await expect(
    adapter.push({
      events: [{ type: "create", collection: "todos", data: { id: "4" } }],
      commitChanges: commit,
    } as never),
  ).rejects.toThrow("update failed");
});

test("Realtime Database default push handles no-op batches, generated IDs, tombstones, and array replacement", async () => {
  const adapter = createRealtimeDBSyncAdapter({
    db: {} as never,
    collections: [{ collectionName: "todos", collectionPath: "todos", createCheckpoint: () => 1 }],
  } as never);
  const commit = vi.fn();
  await adapter.push({
    events: [{ type: "create", collection: "missing", data: {} }],
    commitChanges: commit,
  } as never);
  expect(sdk.updates).toHaveLength(0);
  expect(commit).not.toHaveBeenCalled();
  await adapter.push({
    events: [
      { type: "create", collection: "todos", data: { id: "one" } },
      { type: "update", collection: "todos", data: [1, 2] },
      { type: "delete", collection: "todos", id: "gone" },
    ],
    commitChanges: commit,
  } as never);
  const updates = sdk.updates[0]?.[1] as Record<string, unknown>;
  expect(updates["todos/one"]).toEqual({ id: "one" });
  expect(
    Object.entries(updates).some(
      ([path, value]) => path.startsWith("todos/") && JSON.stringify(value) === "[1,2]",
    ),
  ).toBe(true);
  expect(updates["todos/gone/deleted"]).toBe(true);
  expect(updates["todos/gone/deletedAt"]).toEqual(expect.any(Number));
  expect(commit).toHaveBeenCalledOnce();
});
