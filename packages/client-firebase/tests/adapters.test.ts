import { beforeEach, expect, test, vi } from "vite-plus/test";

const sdk = vi.hoisted(() => ({
  firestoreCallbacks: [] as Array<(snapshot: any) => void>,
  firestoreErrorCallbacks: [] as Array<(error: Error) => void>,
  firestoreUnsubscribes: [] as Array<ReturnType<typeof vi.fn>>,
  firestoreSets: [] as unknown[][],
  firestoreCommits: [] as Array<ReturnType<typeof vi.fn>>,
  /** Ids of the documents written by successful commits, in commit order. */
  firestoreCommitted: [] as string[],
  rtdbCallbacks: {} as Record<string, Array<(snapshot: any) => void>>,
  rtdbCancelCallbacks: {} as Record<string, Array<(error: Error) => void>>,
  rtdbUnsubscribes: {} as Record<string, Array<ReturnType<typeof vi.fn>>>,
  updates: [] as unknown[][],
  /** Realtime Database contents after the multipath updates applied so far. */
  rtdbTree: {} as Record<string, unknown>,
  failCommit: false,
  /** Index (in `firestoreCommits`) of the batch whose commit fails. */
  failBatchAt: -1,
  /** Rejects the next Firestore commit or Realtime Database update. */
  writeError: undefined as unknown,
  /** Thrown synchronously by `WriteBatch.set` and `update`, as SDK validation does. */
  validationError: undefined as unknown,
  /** Document id whose writes the security rules refuse: its whole batch fails. */
  deniedDocument: undefined as string | undefined,
  /** What `getDocFromServer` finds, by document path; a missing path does not exist. */
  serverDocuments: {} as Record<string, Record<string, unknown>>,
  /** Rejects every `getDocFromServer`. */
  serverDocumentError: undefined as unknown,
  /** Queries sent to `getDocsFromServer` / `getCountFromServer`, by function. */
  serverQueries: [] as Array<[string, unknown]>,
  /** What the next `getDocsFromServer` resolves (or rejects) with. */
  previewResult: Promise.resolve({ docs: [] as unknown[] }) as Promise<{ docs: unknown[] }>,
  countResult: Promise.resolve(0) as Promise<number>,
  /** Children the next Realtime Database `get` resolves with (or its rejection). */
  rtdbGetResult: Promise.resolve([] as unknown[]) as Promise<unknown[]>,
  rtdbGets: [] as unknown[],
  /** What a Realtime Database `get` of a record finds, by path; a missing path is empty. */
  rtdbRecords: {} as Record<string, unknown>,
  /** Called while `update` is writing, when the SDK raises the write's child events. */
  rtdbOnWrite: undefined as (() => void) | undefined,
}));

/** An SDK error as Firebase throws it: a `FirebaseError` with its `code`. */
function firebaseError(code: string, message = code): Error {
  return Object.assign(new Error(message), { name: "FirebaseError", code });
}

/** Write `value` at a slash path of `tree`, as a multipath `update` does (null removes it). */
function setTreePath(tree: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split("/");
  const last = segments.pop()!;
  let node = tree;
  for (const segment of segments) {
    const child = node[segment];
    if (typeof child !== "object" || child === null) node[segment] = {};
    node = node[segment] as Record<string, unknown>;
  }
  if (value === null) delete node[last];
  else node[last] = structuredClone(value);
}

vi.mock("firebase/firestore", async (importOriginal) => ({
  Timestamp: (await importOriginal<typeof import("firebase/firestore")>()).Timestamp,
  collection: (_db: unknown, path: string) => ({ path }),
  query: (ref: unknown, ...constraints: unknown[]) => ({ ref, constraints }),
  doc: (_db: unknown, path: string, id: string) => ({ path: `${path}/${id}`, id }),
  getDocFromServer: async ({ path, id }: { path: string; id: string }) => {
    if (sdk.serverDocumentError) throw sdk.serverDocumentError;
    const data = sdk.serverDocuments[path];
    return {
      id,
      exists: () => data !== undefined,
      data: () => data,
      get: (f: string) => data?.[f],
    };
  },
  getDocsFromServer: (source: unknown) => {
    sdk.serverQueries.push(["docs", source]);
    return sdk.previewResult;
  },
  getCountFromServer: (source: unknown) => {
    sdk.serverQueries.push(["count", source]);
    return sdk.countResult.then((count) => ({ data: () => ({ count }) }));
  },
  onSnapshot: (
    _source: unknown,
    _options: unknown,
    callback: (snapshot: any) => void,
    onError: (error: Error) => void,
  ) => {
    // A snapshot without metadata is a server one, as most tests deliver.
    sdk.firestoreCallbacks.push((snapshot) =>
      callback({ metadata: { fromCache: false }, ...snapshot }),
    );
    sdk.firestoreErrorCallbacks.push(onError);
    const unsubscribe = vi.fn();
    sdk.firestoreUnsubscribes.push(unsubscribe);
    return unsubscribe;
  },
  writeBatch: () => {
    const index = sdk.firestoreCommits.length;
    const ids: string[] = [];
    const batch = {
      set: vi.fn((ref: { id: string }, data: unknown, options?: unknown) => {
        if (sdk.validationError) throw sdk.validationError;
        sdk.firestoreSets.push([ref, data, options]);
        ids.push(ref.id);
      }),
      commit: vi.fn(async () => {
        if (sdk.writeError) throw sdk.writeError;
        if (sdk.deniedDocument !== undefined && ids.includes(sdk.deniedDocument)) {
          throw firebaseError("permission-denied", "Missing or insufficient permissions.");
        }
        if (sdk.failCommit || sdk.failBatchAt === index) throw new Error("commit failed");
        sdk.firestoreCommitted.push(...ids);
      }),
    };
    sdk.firestoreCommits.push(batch.commit);
    return batch;
  },
}));

vi.mock("firebase/database", () => {
  // Like the modular SDK: each listener returns its own unsubscribe function.
  const listen =
    (kind: string) =>
    (_target: unknown, callback: (snapshot: any) => void, onError: (error: Error) => void) => {
      (sdk.rtdbCallbacks[kind] ??= []).push(callback);
      (sdk.rtdbCancelCallbacks[kind] ??= []).push(onError);
      const unsubscribe = vi.fn(() => {
        sdk.rtdbCallbacks[kind] = sdk.rtdbCallbacks[kind]!.filter((cb) => cb !== callback);
      });
      (sdk.rtdbUnsubscribes[kind] ??= []).push(unsubscribe);
      return unsubscribe;
    };
  return {
    ref: (_db: unknown, path?: string) => ({ path: path ?? "" }),
    query: (target: unknown, ...constraints: unknown[]) => ({ target, constraints }),
    onChildAdded: listen("added"),
    onChildChanged: listen("changed"),
    onChildRemoved: listen("removed"),
    onValue: listen("value"),
    get: (target: { path?: string }) => {
      sdk.rtdbGets.push(target);
      return sdk.rtdbGetResult.then((children) => {
        const value = sdk.rtdbRecords[target.path ?? ""] ?? null;
        return {
          key: target.path?.split("/").at(-1),
          val: () => value,
          exists: () => value !== null,
          forEach: (visit: (child: unknown) => void) => children.forEach(visit),
        };
      });
    },
    update: (target: unknown, updates: Record<string, unknown>) => {
      // Like the SDK, invalid keys or values throw before a promise is returned.
      if (sdk.validationError) throw sdk.validationError;
      return writeUpdate(target, updates);
    },
  };

  async function writeUpdate(target: unknown, updates: Record<string, unknown>) {
    sdk.updates.push([target, updates]);
    sdk.rtdbOnWrite?.();
    // Like the SDK, reject a multipath update whose paths overlap.
    const paths = Object.keys(updates);
    for (const path of paths) {
      const nested = paths.find((other) => other.startsWith(`${path}/`));
      if (nested) {
        throw new Error(
          `update() contains a path ${path} that is ancestor of another path ${nested}`,
        );
      }
    }
    if (sdk.writeError) throw sdk.writeError;
    if (sdk.failCommit) throw new Error("update failed");
    for (const [path, value] of Object.entries(updates)) setTreePath(sdk.rtdbTree, path, value);
  }
});

import {
  ChangeBus,
  GlobalSyncHandler,
  PushConflictError,
  PushRejectedError,
} from "@ez-kits/sync-client-core";
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
  sdk.firestoreErrorCallbacks.length = 0;
  sdk.firestoreUnsubscribes.length = 0;
  sdk.firestoreSets.length = 0;
  sdk.firestoreCommits.length = 0;
  sdk.firestoreCommitted.length = 0;
  sdk.rtdbCallbacks = {};
  sdk.rtdbCancelCallbacks = {};
  sdk.rtdbUnsubscribes = {};
  sdk.updates.length = 0;
  sdk.rtdbTree = {};
  sdk.failCommit = false;
  sdk.failBatchAt = -1;
  sdk.serverDocuments = {};
  sdk.serverDocumentError = undefined;
  sdk.writeError = undefined;
  sdk.validationError = undefined;
  sdk.deniedDocument = undefined;
  sdk.serverQueries.length = 0;
  sdk.previewResult = Promise.resolve({ docs: [] });
  sdk.countResult = Promise.resolve(0);
  sdk.rtdbGetResult = Promise.resolve([]);
  sdk.rtdbRecords = {};
  sdk.rtdbOnWrite = undefined;
  sdk.rtdbGets.length = 0;
});

test("Firebase pull adapters report listener failures to core", () => {
  const firestoreError = vi.fn();
  void createFirestoreSyncAdapter({
    db: {} as never,
    collections: [{ collectionName: "todos", collectionPath: "todos", createCheckpoint: () => 1 }],
  } as never).pull({ commitChanges: vi.fn(), onError: firestoreError } as never);
  const firestoreFailure = new Error("Firestore listener denied");
  sdk.firestoreErrorCallbacks[0]!(firestoreFailure);
  expect(firestoreError).toHaveBeenCalledWith(firestoreFailure);

  const realtimeError = vi.fn();
  void createRealtimeDBSyncAdapter({
    db: {} as never,
    collections: [{ collectionName: "todos", collectionPath: "todos", createCheckpoint: () => 1 }],
  } as never).pull({ commitChanges: vi.fn(), onError: realtimeError } as never);
  const realtimeFailure = new Error("RTDB listener cancelled");
  sdk.rtdbCancelCallbacks.added![0]!(realtimeFailure);
  sdk.rtdbCancelCallbacks.changed![0]!(realtimeFailure);
  sdk.rtdbCancelCallbacks.removed![0]!(realtimeFailure);
  expect(realtimeError).toHaveBeenCalledTimes(3);
  expect(realtimeError).toHaveBeenCalledWith(realtimeFailure);
});

test("Firebase adapters declare the collections they sync, so core pushes them only those", () => {
  const collections = [
    { collectionName: "todos", collectionPath: "todos", createCheckpoint: () => 1 },
    { collectionName: "projects", collectionPath: "users/7/projects", createCheckpoint: () => 1 },
  ];
  expect(createFirestoreSyncAdapter({ db: {}, collections } as never).collections).toEqual([
    "todos",
    "projects",
  ]);
  expect(createRealtimeDBSyncAdapter({ db: {}, collections } as never).collections).toEqual([
    "todos",
    "projects",
  ]);
});

test("composite collections must say how to rebuild a deleted document's key", () => {
  const items = { name: "items", adapterConfig: {}, primaryField: ["listId", "position"] };
  for (const define of [
    defineFirestoreCollectionSyncAdapterConfig,
    defineRealtimeDBCollectionSyncAdapterConfig,
  ]) {
    expect(() =>
      define({
        collectionConfig: items,
        collectionPath: "items",
        createCheckpoint: () => 1,
      } as never),
    ).toThrow(
      'Collection "items" has a composite primary key: pass deserializeDeleteId to rebuild its ' +
        "key from a deleted document.",
    );
    const deserializeDeleteId = vi.fn();
    expect(
      define({
        collectionConfig: items,
        collectionPath: "items",
        createCheckpoint: () => 1,
        deserializeDeleteId,
      } as never),
    ).toMatchObject({ collectionName: "items", deserializeDeleteId });
  }
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
  const tombstone = docSnapshot("3", { deleted: true, deletedAt: 123 });
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
        { type: "delete", collection: "todos", id: "3", deletedAt: 123 },
        {
          type: "delete",
          collection: "todos",
          id: "4",
          deletedAt: expect.any(Number),
        },
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
  const resolveDeletedAt = vi.fn((raw: any) => raw.removedOn);
  const adapter = createFirestoreCollectionSyncAdapter({
    db: {} as never,
    collectionName: "todos",
    collectionPath: "todos",
    createCheckpoint: () => "cp",
    deserializeCreate: (raw: any) => ({ ...raw, mapped: true }),
    deserializeUpdate: (raw: any) => ({ ...raw, mapped: true }),
    deserializeDeleteId: ({ snapshot }: any) => `custom-${snapshot.id}`,
    isDeleted,
    resolveDeletedAt,
    buildPullQueryConstraints: () => ["where"],
  } as never);
  const commit = vi.fn();
  void adapter.pull({ commitChanges: commit } as never);
  sdk.firestoreCallbacks[0]!({ docChanges: () => [] });
  expect(commit).not.toHaveBeenCalled();
  sdk.firestoreCallbacks[0]!({
    docChanges: () => [
      { type: "added", doc: docSnapshot("x", { id: "x" }) },
      { type: "added", doc: docSnapshot("y", { gone: true, removedOn: 234 }) },
      { type: "modified", doc: docSnapshot("z", { id: "z" }) },
      { type: "removed", doc: docSnapshot("w", {}) },
    ],
  });
  expect(commit.mock.calls[0]?.[0].changes).toEqual([
    { type: "create", collection: "todos", data: { id: "x", mapped: true } },
    {
      type: "delete",
      collection: "todos",
      id: "custom-y",
      deletedAt: 234,
    },
    { type: "update", collection: "todos", data: { id: "z", mapped: true } },
    {
      type: "delete",
      collection: "todos",
      id: "custom-w",
      deletedAt: expect.any(Number),
    },
  ]);
  expect(isDeleted).toHaveBeenCalled();
  expect(resolveDeletedAt).toHaveBeenCalledWith(
    { gone: true, removedOn: 234 },
    { snapshot: expect.objectContaining({ id: "y" }) },
  );
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
        {
          type: "delete",
          collection: "todos",
          id: "z",
          deletedAt: expect.any(Number),
        },
      ],
      checkpoint: { todos: "fallback" },
    }),
  );
});

test("Firestore push serializes events, skips unknown collections, batches at 500, and rejects failed commits", async () => {
  const serializeDelete = vi.fn(() => ({ deleted: true }));
  const adapter = createFirestoreSyncAdapter({
    db: {} as never,
    collections: [
      {
        collectionName: "todos",
        collectionPath: "todos",
        createCheckpoint: () => 1,
        serializeCreate: (data: any) => ({ ...data, remote: true }),
        serializeUpdate: (data: any) => data,
        serializeDelete,
        resolveRemoteId: (e: any) => (e.type === "delete" ? "deleted" : String(e.data.id)),
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
  // Each batch is acknowledged once it is committed.
  expect(commit.mock.calls.map(([call]) => call.events.length)).toEqual([500, 1]);
  const pushed = [
    { type: "update", collection: "todos", data: { id: "u" } },
    { type: "delete", collection: "todos", id: "d", deletedAt: 456 },
  ];
  await adapter.push({ events: pushed, commitChanges: commit } as never);
  expect(serializeDelete).toHaveBeenCalledWith("d", { deletedAt: 456 });
  expect(sdk.firestoreSets.at(-2)?.[2]).toEqual({ merge: true });
  expect(sdk.firestoreSets.at(-1)?.[1]).toEqual({ deleted: true });
  sdk.failCommit = true;
  await expect(
    adapter.push({ events: [pushed[0]], commitChanges: commit } as never),
  ).rejects.toThrow("commit failed");
});

test("Firestore default push mappings write resolved document IDs and soft-delete documents", async () => {
  const resolveRemoteId = vi.fn((event: any) =>
    event.type === "delete" ? `doc-${event.id}` : (event.data.id ?? "resolved-two"),
  );
  const adapter = createFirestoreCollectionSyncAdapter({
    db: {} as never,
    collectionName: "todos",
    collectionPath: "todos",
    createCheckpoint: () => 1,
    resolveRemoteId,
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
  expect(sdk.firestoreSets[0]?.[0]).toEqual({ path: "todos/one", id: "one" });
  expect(sdk.firestoreSets[0]?.[1]).toEqual({ id: "one" });
  expect(sdk.firestoreSets[1]?.[0]).toEqual({ path: "todos/resolved-two", id: "resolved-two" });
  expect(sdk.firestoreSets[1]?.[1]).toEqual({ title: "two" });
  // Deletes go through the resolver too, so they reach the document the writes created.
  expect(resolveRemoteId.mock.calls.map(([event]) => event.type)).toEqual([
    "create",
    "update",
    "delete",
  ]);
  expect(sdk.firestoreSets[2]?.[0]).toEqual({ path: "todos/doc-three", id: "doc-three" });
  expect(sdk.firestoreSets[2]?.[1]).toMatchObject({ deleted: true, deletedAt: expect.any(Number) });
});

test("Realtime Database pull maps all child event forms, commits each tick in one go, and removes listeners", async () => {
  const adapter = createRealtimeDBSyncAdapter({
    db: {} as never,
    collections: [
      {
        collectionName: "todos",
        collectionPath: "todos",
        createCheckpoint: () => "fallback",
        buildPullQuery: () => ({}) as never,
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
  const tombstone = docSnapshot("d", { deleted: true, deletedAt: 567 });
  const removed = docSnapshot("c", {});
  sdk.rtdbCallbacks.added![0]!(added);
  sdk.rtdbCallbacks.added![0]!(tombstone);
  sdk.rtdbCallbacks.changed![0]!(changed);
  sdk.rtdbCallbacks.changed![0]!(docSnapshot("e", { deleted: true, deletedAt: 678 }));
  sdk.rtdbCallbacks.removed![0]!(removed);
  expect(commit).not.toHaveBeenCalled();
  await Promise.resolve();
  // One commit for the tick, with the checkpoint of its last child.
  expect(commit).toHaveBeenCalledOnce();
  expect(commit.mock.calls[0]?.[0]).toEqual({
    changes: [
      { type: "create", collection: "todos", data: { id: "a" } },
      { type: "delete", collection: "todos", id: "d", deletedAt: 567 },
      { type: "update", collection: "todos", data: { id: "b" } },
      { type: "delete", collection: "todos", id: "e", deletedAt: 678 },
      { type: "delete", collection: "todos", id: "c", deletedAt: expect.any(Number) },
    ],
    checkpoint: { todos: "old!!!!!" },
  });
  sdk.rtdbCallbacks.added![0]!(docSnapshot("f", { id: "f" }));
  await Promise.resolve();
  expect(commit).toHaveBeenCalledTimes(2);
  expect(commit.mock.calls[1]?.[0]).toEqual({
    changes: [{ type: "create", collection: "todos", data: { id: "f" } }],
    checkpoint: { todos: "old!!!!!!" },
  });
  cleanup();
  for (const kind of ["added", "changed", "removed"]) {
    expect(sdk.rtdbUnsubscribes[kind]).toHaveLength(1);
    expect(sdk.rtdbUnsubscribes[kind]![0]).toHaveBeenCalledOnce();
  }
  // Nothing is listening any more, so later SDK events never reach core.
  for (const callbacks of Object.values(sdk.rtdbCallbacks)) {
    for (const callback of callbacks) callback(docSnapshot("late", { id: "late" }));
  }
  await Promise.resolve();
  expect(commit).toHaveBeenCalledTimes(2);
});

test("Realtime Database pull uses default listeners and custom mapping hooks", async () => {
  const resolveDeletedAt = vi.fn((raw: any) => raw?.removedOn);
  const adapter = createRealtimeDBCollectionSyncAdapter({
    db: {} as never,
    collectionName: "todos",
    collectionPath: "todos",
    createCheckpoint: () => "cp",
    deserializeCreate: (raw: any) => ({ ...raw, created: true }),
    deserializeUpdate: (raw: any) => ({ ...raw, updated: true }),
    deserializeDeleteId: ({ snapshot }: any) => `custom-${snapshot.key}`,
    isDeleted: (raw: any) => raw?.gone === true,
    resolveDeletedAt,
  } as never);
  const commit = vi.fn();
  void adapter.pull({ commitChanges: commit } as never);
  sdk.rtdbCallbacks.added![0]!(docSnapshot("a", { id: "a" }));
  sdk.rtdbCallbacks.added![0]!(docSnapshot("d", { gone: true, removedOn: 345 }));
  sdk.rtdbCallbacks.changed![0]!(docSnapshot("b", { id: "b" }));
  sdk.rtdbCallbacks.changed![0]!(docSnapshot("e", { gone: true, removedOn: 456 }));
  sdk.rtdbCallbacks.removed![0]!(docSnapshot("c", {}));
  await Promise.resolve();
  expect(commit.mock.calls.flatMap(([call]) => call.changes)).toEqual([
    { type: "create", collection: "todos", data: { id: "a", created: true } },
    {
      type: "delete",
      collection: "todos",
      id: "custom-d",
      deletedAt: 345,
    },
    { type: "update", collection: "todos", data: { id: "b", updated: true } },
    {
      type: "delete",
      collection: "todos",
      id: "custom-e",
      deletedAt: 456,
    },
    {
      type: "delete",
      collection: "todos",
      id: "custom-c",
      deletedAt: expect.any(Number),
    },
  ]);
  expect(resolveDeletedAt).toHaveBeenCalledWith(
    { gone: true, removedOn: 345 },
    { snapshot: expect.objectContaining({ key: "d" }) },
  );
});

test("Realtime Database push merges update paths, replaces non-objects, skips unknown collections, and propagates errors", async () => {
  const serializeDelete = vi.fn(() => "gone");
  const adapter = createRealtimeDBCollectionSyncAdapter({
    db: {} as never,
    collectionName: "todos",
    collectionPath: "todos",
    createCheckpoint: () => 1,
    serializeCreate: (data: any) => ({ ...data, encoded: true }),
    serializeUpdate: () => ({ nested: { value: 2 } }),
    serializeDelete,
    resolveRemoteId: (event: any) => String(event.type === "delete" ? event.id : event.data.id),
  } as never);
  const commit = vi.fn();
  await adapter.push({
    events: [
      { type: "create", collection: "todos", data: { id: "1" } },
      { type: "update", collection: "todos", data: { id: "1" } },
      { type: "delete", collection: "todos", id: "2", deletedAt: 789 },
      { type: "create", collection: "other", data: { id: "3" } },
    ],
    commitChanges: commit,
  } as never);
  // The update is merged into the created record instead of writing an overlapping path.
  expect(sdk.updates[0]?.[1]).toEqual({
    "todos/1": { id: "1", encoded: true, nested: { value: 2 } },
    "todos/2": "gone",
  });
  expect(serializeDelete).toHaveBeenCalledWith("2", { deletedAt: 789 });
  expect(commit).toHaveBeenCalledOnce();
  sdk.failCommit = true;
  await expect(
    adapter.push({
      events: [{ type: "create", collection: "todos", data: { id: "4" } }],
      commitChanges: commit,
    } as never),
  ).rejects.toThrow("update failed");
});

test("Realtime Database default push handles no-op batches, resolved IDs, tombstones, and array replacement", async () => {
  const resolveRemoteId = vi.fn((event: any) => {
    if (event.type === "delete") return `record-${event.id}`;
    return Array.isArray(event.data) ? "resolved-list" : event.data.id;
  });
  const adapter = createRealtimeDBSyncAdapter({
    db: {} as never,
    collections: [
      {
        collectionName: "todos",
        collectionPath: "todos",
        createCheckpoint: () => 1,
        resolveRemoteId,
      },
    ],
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
  // Arrays replace the record instead of merging field by field.
  expect(updates["todos/resolved-list"]).toEqual([1, 2]);
  expect(resolveRemoteId.mock.calls.map(([event]) => event.type)).toEqual([
    "create",
    "update",
    "delete",
  ]);
  expect(updates["todos/record-gone/deleted"]).toBe(true);
  expect(updates["todos/record-gone/deletedAt"]).toEqual(expect.any(Number));
  expect(commit).toHaveBeenCalledOnce();
});

test("Firestore pull reads tombstone timestamps exposed through toMillis", () => {
  const adapter = createFirestoreCollectionSyncAdapter({
    db: {} as never,
    collectionPath: "todos",
    createCheckpoint: () => "checkpoint",
  } as never);
  const commitChanges = vi.fn();
  const cleanup = adapter.pull({ commitChanges } as never) as () => void;
  const tombstone = docSnapshot("5", { deleted: true, deletedAt: { toMillis: () => 789 } });
  sdk.firestoreCallbacks[0]!({ docChanges: () => [{ type: "modified", doc: tombstone }] });
  expect(commitChanges).toHaveBeenCalledWith(
    expect.objectContaining({
      changes: [{ type: "delete", collection: "todos", id: "5", deletedAt: 789 }],
    }),
  );
  cleanup();
});

test("Firebase pushes resolve only after core has acknowledged the pushed events", async () => {
  const config = {
    db: {} as never,
    collectionPath: "todos",
    createCheckpoint: () => 1,
    resolveRemoteId: (event: any) => String(event.data.id),
  };
  for (const adapter of [
    createFirestoreCollectionSyncAdapter(config as never),
    createRealtimeDBCollectionSyncAdapter(config as never),
  ]) {
    let acknowledge!: () => void;
    const commitChanges = vi.fn(() => new Promise<void>((resolve) => (acknowledge = resolve)));
    let pushed = false;
    const push = Promise.resolve(
      adapter.push({
        events: [{ type: "create", collection: "todos", data: { id: "a" } }],
        commitChanges,
      } as never),
    ).then(() => (pushed = true));
    await vi.waitFor(() => expect(commitChanges).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pushed).toBe(false);
    acknowledge();
    await push;

    // A failed acknowledgement fails the push, so core retries it.
    commitChanges.mockRejectedValueOnce(new Error("ack failed"));
    await expect(
      adapter.push({
        events: [{ type: "create", collection: "todos", data: { id: "b" } }],
        commitChanges,
      } as never),
    ).rejects.toThrow("ack failed");
  }
});

const realtimeTodos = (overrides: Record<string, unknown> = {}) =>
  createRealtimeDBCollectionSyncAdapter({
    db: {} as never,
    collectionName: "todos",
    collectionPath: "todos",
    createCheckpoint: () => 1,
    resolveRemoteId: (event: any) => String(event.type === "delete" ? event.id : event.data.id),
    ...overrides,
  } as never);

/** Push `events` and return the events acknowledged by each `commitChanges` call. */
async function pushRealtime(adapter: ReturnType<typeof realtimeTodos>, events: unknown[]) {
  const commit = vi.fn(async (_options: { events: unknown[] }) => undefined);
  await adapter.push({ events, commitChanges: commit } as never);
  return commit.mock.calls.map(([call]) => call.events);
}

test("Realtime Database push coalesces a create and later updates of one record into a single replace", async () => {
  sdk.rtdbTree = { todos: { "1": { id: "1", stale: true } } };
  const events = [
    { type: "create", collection: "todos", data: { id: "1", title: "a", done: false } },
    { type: "update", collection: "todos", data: { id: "1", title: "b" } },
    { type: "update", collection: "todos", data: { id: "1", tags: { x: 1 } } },
  ];
  expect(await pushRealtime(realtimeTodos(), events)).toEqual([events]);
  expect(sdk.updates.map(([, updates]) => updates)).toEqual([
    { "todos/1": { id: "1", title: "b", done: false, tags: { x: 1 } } },
  ]);
  expect(sdk.rtdbTree).toEqual({
    todos: { "1": { id: "1", title: "b", done: false, tags: { x: 1 } } },
  });
});

test("Realtime Database push lets a create after field updates replace the record", async () => {
  sdk.rtdbTree = { todos: { "1": { id: "1", extra: true } } };
  const events = [
    { type: "update", collection: "todos", data: { id: "1", title: "x" } },
    { type: "update", collection: "todos", data: { id: "1", done: true } },
    { type: "create", collection: "todos", data: { id: "1", title: "c" } },
  ];
  expect(await pushRealtime(realtimeTodos(), events)).toEqual([events]);
  expect(sdk.updates.map(([, updates]) => updates)).toEqual([
    { "todos/1": { id: "1", title: "c" } },
  ]);
  expect(sdk.rtdbTree).toEqual({ todos: { "1": { id: "1", title: "c" } } });
});

test("Realtime Database push merges a delete into a record created in the same push, and a create replaces a tombstone", async () => {
  const createThenDelete = [
    { type: "create", collection: "todos", data: { id: "1", title: "a" } },
    { type: "delete", collection: "todos", id: "1", deletedAt: 5 },
  ];
  expect(await pushRealtime(realtimeTodos(), createThenDelete)).toEqual([createThenDelete]);
  expect(sdk.rtdbTree).toEqual({
    todos: { "1": { id: "1", title: "a", deleted: true, deletedAt: 5 } },
  });

  const deleteThenCreate = [
    { type: "delete", collection: "todos", id: "2", deletedAt: 6 },
    { type: "create", collection: "todos", data: { id: "2", title: "again" } },
  ];
  expect(await pushRealtime(realtimeTodos(), deleteThenCreate)).toEqual([deleteThenCreate]);
  expect(sdk.updates.at(-1)?.[1]).toEqual({ "todos/2": { id: "2", title: "again" } });
  expect(sdk.rtdbTree).toMatchObject({ todos: { "2": { id: "2", title: "again" } } });
});

test("Realtime Database push replays an offline history of several records as one non-overlapping update", async () => {
  sdk.rtdbTree = { todos: { "2": { id: "2", title: "old", done: false } } };
  const events = [
    { type: "create", collection: "todos", data: { id: "1", title: "a" } },
    { type: "update", collection: "todos", data: { id: "2", title: "two" } },
    { type: "update", collection: "todos", data: { id: "1", title: "b" } },
    { type: "update", collection: "todos", data: { id: "1", done: true } },
    { type: "delete", collection: "todos", id: "1", deletedAt: 7 },
    { type: "update", collection: "todos", data: { id: "2", done: true } },
    { type: "create", collection: "todos", data: { id: "1", title: "reborn" } },
    { type: "delete", collection: "todos", id: "3", deletedAt: 8 },
  ];
  expect(await pushRealtime(realtimeTodos(), events)).toEqual([events]);
  expect(sdk.updates.map(([, updates]) => updates)).toEqual([
    {
      "todos/1": { id: "1", title: "reborn" },
      "todos/2/id": "2",
      "todos/2/title": "two",
      "todos/2/done": true,
      "todos/3/deleted": true,
      "todos/3/deletedAt": 8,
    },
  ]);
  expect(sdk.rtdbTree).toEqual({
    todos: {
      "1": { id: "1", title: "reborn" },
      "2": { id: "2", title: "two", done: true },
      "3": { deleted: true, deletedAt: 8 },
    },
  });
});

test("Realtime Database push splits records whose paths nest into ordered updates, acknowledging each", async () => {
  const adapter = createRealtimeDBSyncAdapter({
    db: {} as never,
    collections: [
      {
        collectionName: "todos",
        collectionPath: "todos",
        createCheckpoint: () => 1,
        // User-chosen ids may contain slashes, so one record can sit inside another.
        resolveRemoteId: (event: any) => String(event.type === "delete" ? event.id : event.data.id),
      },
      {
        collectionName: "comments",
        collectionPath: "todos/1/comments",
        createCheckpoint: () => 1,
        resolveRemoteId: (event: any) => String(event.data.id),
      },
    ],
  } as never);
  const events = [
    { type: "create", collection: "todos", data: { id: "1", title: "a" } },
    { type: "update", collection: "todos", data: { id: "1/title", text: "nested" } },
    { type: "create", collection: "comments", data: { id: "c", text: "hi" } },
    { type: "update", collection: "todos", data: { id: "1", done: true } },
    { type: "delete", collection: "todos", id: "1", deletedAt: 9 },
  ];
  const commit = vi.fn(async (_options: { events: unknown[] }) => undefined);
  await adapter.push({ events, commitChanges: commit } as never);
  expect(sdk.updates.map(([, updates]) => updates)).toEqual([
    { "todos/1": { id: "1", title: "a" } },
    {
      "todos/1/title/id": "1/title",
      "todos/1/title/text": "nested",
      "todos/1/comments/c": { id: "c", text: "hi" },
    },
    {
      "todos/1/id": "1",
      "todos/1/done": true,
      "todos/1/deleted": true,
      "todos/1/deletedAt": 9,
    },
  ]);
  expect(commit.mock.calls.map(([call]) => call.events)).toEqual([
    [events[0]],
    [events[1], events[2]],
    [events[3], events[4]],
  ]);
  expect(sdk.rtdbTree).toEqual({
    todos: {
      "1": {
        id: "1",
        title: { id: "1/title", text: "nested" },
        comments: { c: { id: "c", text: "hi" } },
        done: true,
        deleted: true,
        deletedAt: 9,
      },
    },
  });
});

test("Realtime Database push does not coalesce deep-path update fields, and merges fields into a replaced primitive", async () => {
  const adapter = realtimeTodos({ serializeUpdate: (data: any) => data.fields });
  const events = [
    { type: "update", collection: "todos", data: { id: "1", fields: { meta: { a: 1 } } } },
    { type: "update", collection: "todos", data: { id: "1", fields: { "meta/b": 2 } } },
    { type: "update", collection: "todos", data: { id: "1", fields: { meta: { c: 3 } } } },
    { type: "update", collection: "todos", data: { id: "2", fields: "flat" } },
    { type: "update", collection: "todos", data: { id: "2", fields: { title: "obj" } } },
  ];
  expect(await pushRealtime(adapter, events)).toEqual([
    [events[0]],
    [events[1]],
    [events[2], events[3], events[4]],
  ]);
  expect(sdk.updates.map(([, updates]) => updates)).toEqual([
    { "todos/1/meta": { a: 1 } },
    { "todos/1/meta/b": 2 },
    { "todos/1/meta": { c: 3 }, "todos/2": { title: "obj" } },
  ]);
  expect(sdk.rtdbTree).toEqual({ todos: { "1": { meta: { c: 3 } }, "2": { title: "obj" } } });

  // An update without fields writes nothing but is still acknowledged.
  const empty = { type: "update", collection: "todos", data: { id: "1", fields: {} } };
  expect(await pushRealtime(adapter, [empty])).toEqual([[empty]]);
  expect(sdk.updates).toHaveLength(3);
});

test("Realtime Database push stops at a failed update, acknowledging only the updates written before it", async () => {
  const events = [
    { type: "create", collection: "todos", data: { id: "1" } },
    { type: "create", collection: "todos", data: { id: "1/x" } },
  ];
  const commit = vi.fn(async (_options: { events: unknown[] }) => {
    sdk.failCommit = true;
  });
  await expect(realtimeTodos().push({ events, commitChanges: commit } as never)).rejects.toThrow(
    "update failed",
  );
  expect(commit.mock.calls.map(([call]) => call.events)).toEqual([[events[0]]]);
});

test("Realtime Database deletes use the configured record id resolver", async () => {
  const serializeDelete = vi.fn((_id: unknown, { deletedAt }: { deletedAt: number }) => ({
    deleted: true,
    deletedAt,
  }));
  const adapter = realtimeTodos({
    serializeDelete,
    resolveRemoteId: (event: any) => `remote-${event.type === "delete" ? event.id : event.data.id}`,
  });
  await pushRealtime(adapter, [
    { type: "create", collection: "todos", data: { id: "1", title: "a" } },
  ]);
  await pushRealtime(adapter, [{ type: "delete", collection: "todos", id: "1", deletedAt: 3 }]);
  expect(serializeDelete).toHaveBeenCalledWith("1", { deletedAt: 3 });
  expect(sdk.rtdbTree).toEqual({
    todos: { "remote-1": { id: "1", title: "a", deleted: true, deletedAt: 3 } },
  });
});

test("Firestore deletes use the configured document id resolver", async () => {
  const serializeDelete = vi.fn(() => ({ deleted: true }));
  const adapter = createFirestoreCollectionSyncAdapter({
    db: {} as never,
    collectionName: "todos",
    collectionPath: "todos",
    createCheckpoint: () => 1,
    serializeDelete,
    resolveRemoteId: (event: any) => `remote-${event.type === "delete" ? event.id : event.data.id}`,
  } as never);
  await adapter.push({
    events: [
      { type: "create", collection: "todos", data: { id: "1" } },
      { type: "delete", collection: "todos", id: "1", deletedAt: 3 },
    ],
    commitChanges: vi.fn(),
  } as never);
  expect(sdk.firestoreSets.map(([ref]) => ref)).toEqual([
    { path: "todos/remote-1", id: "remote-1" },
    { path: "todos/remote-1", id: "remote-1" },
  ]);
  expect(serializeDelete).toHaveBeenCalledWith("1", { deletedAt: 3 });
});

test("Firestore push acknowledges each committed batch, so a retry after a failed batch makes progress", async () => {
  const adapter = createFirestoreCollectionSyncAdapter({
    db: {} as never,
    collectionName: "todos",
    collectionPath: "todos",
    createCheckpoint: () => 1,
    resolveRemoteId: (event: any) => String(event.data.id),
  } as never);
  const events = Array.from({ length: 1001 }, (_, i) => ({
    type: "create",
    collection: "todos",
    data: { id: String(i) },
  }));
  let acknowledge!: () => void;
  const commit = vi.fn(
    (_options: { events: unknown[] }) => new Promise<void>((resolve) => (acknowledge = resolve)),
  );
  sdk.failBatchAt = 1;
  const push = adapter.push({ events, commitChanges: commit } as never);
  await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
  // The next batch waits until the previous one is acknowledged.
  expect(sdk.firestoreCommits[1]).not.toHaveBeenCalled();
  acknowledge();
  await expect(push).rejects.toThrow("commit failed");
  expect(sdk.firestoreCommits[2]).not.toHaveBeenCalled();
  expect(commit.mock.calls.map(([call]) => call.events)).toEqual([events.slice(0, 500)]);

  // Core re-sends only what is still in the outbox.
  sdk.failBatchAt = -1;
  const retry = vi.fn(async (_options: { events: unknown[] }) => undefined);
  await adapter.push({ events: events.slice(500), commitChanges: retry } as never);
  expect(retry.mock.calls.map(([call]) => call.events)).toEqual([
    events.slice(500, 1000),
    events.slice(1000),
  ]);
});

const firestoreTodos = () =>
  createFirestoreCollectionSyncAdapter({
    db: {} as never,
    collectionName: "todos",
    collectionPath: "todos",
    createCheckpoint: () => 1,
    resolveRemoteId: (event: any) => String(event.data.id),
  } as never);

const todoCreate = (id: string) => ({ type: "create", collection: "todos", data: { id } });

async function pushFailure(adapter: { push: (options: any) => unknown }) {
  const commitChanges = vi.fn(async () => undefined);
  try {
    await adapter.push({ events: [todoCreate("1")], commitChanges });
  } catch (error) {
    expect(commitChanges).not.toHaveBeenCalled();
    return error;
  }
  throw new Error("push succeeded");
}

test("Firestore push rejections from rules and validation are permanent; other failures retriable", async () => {
  for (const code of [
    "permission-denied",
    "invalid-argument",
    "out-of-range",
    "failed-precondition",
  ]) {
    const cause = firebaseError(code, `${code}: refused`);
    sdk.writeError = cause;
    const failure = await pushFailure(firestoreTodos());
    expect(failure).toBeInstanceOf(PushRejectedError);
    expect(failure).toMatchObject({
      permanent: true,
      cause,
      message: `Firestore rejected the write (${code}).`,
    });
  }
  for (const code of [
    "unauthenticated",
    "unavailable",
    "deadline-exceeded",
    "resource-exhausted",
    "aborted",
    "internal",
    "unknown",
    "cancelled",
  ]) {
    const cause = firebaseError(code);
    sdk.writeError = cause;
    expect(await pushFailure(firestoreTodos())).toBe(cause);
  }
});

test("Firestore push rejects invalid data, which the SDK throws before committing, as permanent", async () => {
  const cause = firebaseError("invalid-argument", "Unsupported field value: undefined");
  sdk.validationError = cause;
  const failure = await pushFailure(firestoreTodos());
  expect(failure).toBeInstanceOf(PushRejectedError);
  expect(failure).toMatchObject({ cause });
  expect(sdk.firestoreCommits[0]).not.toHaveBeenCalled();

  // An error without a Firebase code is not a refusal Firestore classified: it is retried.
  const unexpected = new Error("serializer bug");
  sdk.validationError = unexpected;
  expect(await pushFailure(firestoreTodos())).toBe(unexpected);
});

test("Realtime Database push rejections from rules and SDK validation are permanent; others retriable", async () => {
  // As the SDK reports a refused write: the server status, upper-cased, in `code`.
  const denied = Object.assign(new Error("PERMISSION_DENIED: Permission denied"), {
    code: "PERMISSION_DENIED",
  });
  sdk.writeError = denied;
  const failure = await pushFailure(realtimeTodos());
  expect(failure).toBeInstanceOf(PushRejectedError);
  expect(failure).toMatchObject({
    cause: denied,
    message: "Realtime Database rejected the write (PERMISSION_DENIED).",
  });

  for (const code of ["DISCONNECTED", "EXPIRED_TOKEN", "INVALID_TOKEN", "UNAVAILABLE"]) {
    const cause = Object.assign(new Error(code), { code });
    sdk.writeError = cause;
    expect(await pushFailure(realtimeTodos())).toBe(cause);
  }
  sdk.writeError = undefined;
  const updatesSent = sdk.updates.length;

  // The SDK validates keys and values synchronously; such an update can never be written.
  const invalid = new Error("update failed: values argument contains undefined in property 'x'");
  sdk.validationError = invalid;
  const rejected = await pushFailure(realtimeTodos());
  expect(rejected).toBeInstanceOf(PushRejectedError);
  expect(rejected).toMatchObject({
    cause: invalid,
    message: "Realtime Database rejected the write.",
  });
  expect(sdk.updates).toHaveLength(updatesSent);
});

test("one write refused by Firestore rules is parked without blocking its batch or later writes", async () => {
  const outbox = new Map<string, any>();
  const store = {
    initialize: async () => {},
    appendEvents: async (events: any[]) => {
      for (const event of events) outbox.set(event.id, event);
    },
    hasAppliedEvent: async () => false,
    getPendingEvents: async (scope?: any) =>
      [...outbox.values()].filter(
        (event) =>
          typeof scope !== "object" ||
          (event.collection === scope.collection && event.recordId === scope.recordId),
      ),
    deleteEvents: async (ids: string[]) => {
      for (const id of ids) outbox.delete(id);
    },
    getCheckpoint: async () => undefined,
    saveCheckpoint: async () => {},
    // No remote event is skipped: nothing is pulled.
    getSkippedRemoteEvents: async () => [],
    getRevision: async () => undefined,
    upsertRevision: async () => {},
    removeRevisions: async () => {},
    upsertSkippedRemoteEvent: async () => {},
    removeSkippedRemoteEvents: async () => {},
  };
  const db: any = {
    transaction: async (fn: any) => fn(db, { operations: db, native: undefined }),
  };
  // 600 offline creates: two Firestore batches, the first holding the refused document.
  const ids = Array.from({ length: 600 }, (_, i) => (i === 250 ? "denied" : String(i)));
  for (const [i, id] of ids.entries()) {
    await store.appendEvents([
      {
        id: `e${i}`,
        type: "create",
        collection: "todos",
        recordId: id,
        data: { id },
        createdAt: i,
      },
    ]);
  }
  sdk.deniedDocument = "denied";
  const onPushRejected = vi.fn();
  const handler = new GlobalSyncHandler({
    collections: [{ name: "todos", primaryField: "id", adapterConfig: {} }],
    syncAdapter: firestoreTodos(),
    db,
    changeBus: new ChangeBus<any>(),
    checkpointStorage: { getCheckpoint: async () => undefined, saveCheckpoint: async () => {} },
    localChangeStore: store,
    onPushRejected,
  } as never);
  handler.start();
  await vi.waitFor(() => expect(outbox.size).toBe(1));

  expect(onPushRejected).toHaveBeenCalledOnce();
  const [rejection] = onPushRejected.mock.calls[0]!;
  expect(rejection).toMatchObject({
    event: { type: "create", data: { id: "denied" }, eventId: "e250" },
    error: { permanent: true, cause: { code: "permission-denied" } },
  });
  // Parked, not lost: the refused write stays.
  expect([...outbox.keys()]).toEqual(["e250"]);
  // Every other document is committed exactly once, in outbox order.
  expect(sdk.firestoreCommitted).toEqual(ids.filter((id) => id !== "denied"));

  await rejection.discard();
  expect(outbox.size).toBe(0);
  handler.stop();
});

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

function firestorePreviewAdapter(extra: Record<string, unknown> = {}) {
  return createFirestoreSyncAdapter({
    db: {} as never,
    collections: [
      {
        collectionName: "todos",
        collectionPath: "todos",
        createCheckpoint: () => "cp",
        buildPullQueryConstraints: ({ checkpoint }: any) => (checkpoint ? ["after"] : ["full"]),
        buildPreviewQueryConstraints: () => ["newest", "limit"],
        countInitialPull: true,
        ...extra,
      },
    ],
  } as never);
}

test("Firestore first pull: preview rows commit first, then the listener opens; the count uses the full pull query", async () => {
  const log: string[] = [];
  const commitChanges = vi.fn(({ preview }: any) => log.push(preview ? "preview" : "batch"));
  const onPreviewed = vi.fn(() => log.push("previewed"));
  const onCount = vi.fn();
  sdk.previewResult = Promise.resolve({
    docs: [docSnapshot("1", { id: "1" }), docSnapshot("2", { deleted: true })],
  });
  sdk.countResult = Promise.resolve(3_000);
  void firestorePreviewAdapter().pull({ commitChanges, onPreviewed, onCount } as never);

  expect(sdk.firestoreCallbacks).toHaveLength(0);
  await flush();
  expect(sdk.serverQueries).toEqual([
    ["count", { ref: { path: "todos" }, constraints: ["full"] }],
    ["docs", { ref: { path: "todos" }, constraints: ["newest", "limit"] }],
  ]);
  expect(commitChanges).toHaveBeenCalledWith({
    changes: [
      { type: "create", collection: "todos", data: { id: "1" } },
      { type: "delete", collection: "todos", id: "2", deletedAt: expect.any(Number) },
    ],
    checkpoint: {},
    preview: true,
  });
  expect(onPreviewed).toHaveBeenCalledWith({ collection: "todos", hasData: true });
  expect(onCount).toHaveBeenCalledWith({ collection: "todos", total: 3_000 });
  expect(sdk.firestoreCallbacks).toHaveLength(1);
  sdk.firestoreCallbacks[0]!({ docChanges: () => [{ type: "added", doc: docSnapshot("1", {}) }] });
  expect(log).toEqual(["preview", "previewed", "batch"]);
});

test("Firestore preview and count run only on a first pull; a failed preview still opens the listener", async () => {
  void firestorePreviewAdapter().pull({
    checkpoint: { todos: "cp" },
    commitChanges: vi.fn(),
  } as never);
  expect(sdk.serverQueries).toEqual([]);
  expect(sdk.firestoreCallbacks).toHaveLength(1);

  sdk.previewResult = Promise.reject(new Error("offline"));
  sdk.countResult = Promise.reject(new Error("offline"));
  const commitChanges = vi.fn();
  const onPreviewed = vi.fn();
  void firestorePreviewAdapter().pull({ commitChanges, onPreviewed } as never);
  await flush();
  expect(commitChanges).not.toHaveBeenCalled();
  expect(onPreviewed).not.toHaveBeenCalled();
  expect(sdk.firestoreCallbacks).toHaveLength(2);
});

test("Firestore pull stopped during the preview never opens its listener", async () => {
  let resolve!: (value: { docs: unknown[] }) => void;
  sdk.previewResult = new Promise((done) => (resolve = done));
  const commitChanges = vi.fn();
  const cleanup = firestorePreviewAdapter().pull({ commitChanges } as never) as () => void;
  cleanup();
  resolve({ docs: [docSnapshot("1", { id: "1" })] });
  await flush();
  expect(commitChanges).not.toHaveBeenCalled();
  expect(sdk.firestoreCallbacks).toHaveLength(0);
});

test("Firestore pull catches up on the first snapshot from the server, once, even without changes", () => {
  const commitChanges = vi.fn();
  const onCaughtUp = vi.fn();
  void firestorePreviewAdapter({
    buildPreviewQueryConstraints: undefined,
    countInitialPull: false,
  }).pull({ checkpoint: { todos: "cp" }, commitChanges, onCaughtUp } as never);
  sdk.firestoreCallbacks[0]!({
    metadata: { fromCache: true },
    docChanges: () => [{ type: "added", doc: docSnapshot("1", { id: "1" }) }],
  });
  expect(commitChanges).toHaveBeenCalledOnce();
  expect(onCaughtUp).not.toHaveBeenCalled();
  sdk.firestoreCallbacks[0]!({ metadata: { fromCache: false }, docChanges: () => [] });
  expect(commitChanges).toHaveBeenCalledOnce();
  expect(onCaughtUp).toHaveBeenCalledExactlyOnceWith(["todos"]);
  sdk.firestoreCallbacks[0]!({ metadata: { fromCache: false }, docChanges: () => [] });
  expect(onCaughtUp).toHaveBeenCalledOnce();
});

test("Realtime Database pull catches up on a one-time value event, after the child events", () => {
  const log: string[] = [];
  const onError = vi.fn();
  const cleanup = createRealtimeDBCollectionSyncAdapter({
    db: {} as never,
    collectionPath: "todos",
    createCheckpoint: () => 1,
  } as never).pull({
    commitChanges: () => log.push("child"),
    onCaughtUp: (collections: string[]) => log.push(`caught up ${collections.join(",")}`),
    onError,
  } as never) as () => void;
  sdk.rtdbCallbacks.added![0]!(docSnapshot("1", { id: "1" }));
  sdk.rtdbCallbacks.value![0]!({});
  expect(log).toEqual(["child", "caught up todos"]);
  // A refused value read fails the stream like any listener.
  const denied = firebaseError("permission-denied");
  sdk.rtdbCancelCallbacks.value![0]!(denied);
  expect(onError).toHaveBeenCalledWith(denied);
  cleanup();
  expect(sdk.rtdbUnsubscribes.value![0]).toHaveBeenCalledOnce();
});

function rtdbPreviewAdapter(count = vi.fn(async () => 3_000)) {
  return createRealtimeDBCollectionSyncAdapter({
    db: {} as never,
    collectionPath: "todos",
    createCheckpoint: () => 1,
    buildPreviewQuery: ({ collectionPath }: any) => ({ preview: collectionPath }),
    countInitialPull: count,
  } as never);
}

test("Realtime Database first pull: preview children commit first, then the listeners open; the app counts", async () => {
  const log: string[] = [];
  const commitChanges = vi.fn(({ preview }: any) => log.push(preview ? "preview" : "child"));
  const onPreviewed = vi.fn(() => log.push("previewed"));
  const onCount = vi.fn();
  const count = vi.fn(async () => 3_000);
  sdk.rtdbGetResult = Promise.resolve([
    docSnapshot("1", { id: "1" }),
    docSnapshot("2", { deleted: true, deletedAt: 5 }),
  ]);
  const onCaughtUp = vi.fn(() => log.push("caughtUp"));
  void rtdbPreviewAdapter(count).pull({
    commitChanges,
    onPreviewed,
    onCount,
    onCaughtUp,
  } as never);
  expect(sdk.rtdbCallbacks.added).toBeUndefined();
  await flush();

  expect(sdk.rtdbGets).toEqual([{ preview: "todos" }]);
  expect(count).toHaveBeenCalledWith({ db: {}, collectionPath: "todos" });
  expect(onCount).toHaveBeenCalledWith({ collection: "todos", total: 3_000 });
  expect(commitChanges).toHaveBeenCalledWith({
    changes: [
      { type: "create", collection: "todos", data: { id: "1" } },
      { type: "delete", collection: "todos", id: "2", deletedAt: 5 },
    ],
    checkpoint: {},
    preview: true,
  });
  expect(onPreviewed).toHaveBeenCalledWith({ collection: "todos", hasData: true });
  sdk.rtdbCallbacks.added![0]!(docSnapshot("1", { id: "1" }));
  // The value event right after the children commits them before reporting caught up.
  sdk.rtdbCallbacks.value![0]!(undefined);
  expect(log).toEqual(["preview", "previewed", "child", "caughtUp"]);
});

test("Realtime Database preview and count run only on a first pull; failures still open the listeners", async () => {
  const count = vi.fn(async () => 1);
  void rtdbPreviewAdapter(count).pull({
    checkpoint: { todos: 9 },
    commitChanges: vi.fn(),
  } as never);
  expect(sdk.rtdbGets).toEqual([]);
  expect(count).not.toHaveBeenCalled();
  expect(sdk.rtdbCallbacks.added).toHaveLength(1);

  sdk.rtdbGetResult = Promise.reject(new Error("offline"));
  const commitChanges = vi.fn();
  const onCount = vi.fn();
  void rtdbPreviewAdapter(
    vi.fn(async () => {
      throw new Error("no counter");
    }),
  ).pull({ commitChanges, onCount } as never);
  await flush();
  expect(commitChanges).not.toHaveBeenCalled();
  expect(onCount).not.toHaveBeenCalled();
  expect(sdk.rtdbCallbacks.added).toHaveLength(2);
});

test("Realtime Database pull stopped during the preview never opens its listeners", async () => {
  let resolve!: (children: unknown[]) => void;
  sdk.rtdbGetResult = new Promise((done) => (resolve = done));
  const commitChanges = vi.fn();
  const onCount = vi.fn();
  const cleanup = rtdbPreviewAdapter().pull({ commitChanges, onCount } as never) as () => void;
  cleanup();
  resolve([docSnapshot("1", { id: "1" })]);
  await flush();
  expect(commitChanges).not.toHaveBeenCalled();
  expect(onCount).not.toHaveBeenCalled();
  expect(sdk.rtdbCallbacks.added).toBeUndefined();
});

function revisionedAdapter(overrides: Record<string, unknown> = {}) {
  return createFirestoreCollectionSyncAdapter({
    db: {} as never,
    collectionName: "todos",
    collectionPath: "todos",
    revisionField: "rev",
    createCheckpoint: () => "cp",
    resolveRemoteId: (event: any) => String(event.type === "delete" ? event.id : event.data.id),
    ...overrides,
  } as never);
}

test("Firestore lists only the collections with a revision field as revisioned", () => {
  const base = { createCheckpoint: () => "cp", resolveRemoteId: () => "id" };
  const adapter = createFirestoreSyncAdapter({
    db: {} as never,
    collections: [
      { ...base, collectionName: "todos", collectionPath: "todos", revisionField: "rev" },
      { ...base, collectionName: "notes", collectionPath: "notes" },
    ],
  } as never);
  expect(adapter.revisionedCollections).toEqual(["todos"]);
});

test("Firestore reads the revision of pulled documents and leaves it out of the row", () => {
  const adapter = revisionedAdapter();
  const commit = vi.fn();
  void adapter.pull({ commitChanges: commit } as never);
  const pending = {
    id: "p",
    data: () => ({ id: "p", rev: 9 }),
    metadata: { hasPendingWrites: true },
  };
  const confirmed = (id: string, data: object) => ({
    id,
    data: () => data,
    metadata: { hasPendingWrites: false },
  });
  sdk.firestoreCallbacks[0]!({
    docChanges: () => [
      { type: "added", doc: confirmed("a", { id: "a", title: "new", rev: 1 }) },
      { type: "modified", doc: confirmed("b", { id: "b", title: "edit", rev: 2 }) },
      { type: "modified", doc: confirmed("c", { id: "c", deleted: true, deletedAt: 5, rev: 3 }) },
      { type: "modified", doc: confirmed("d", { id: "d", title: "not a number", rev: "4" }) },
      { type: "removed", doc: confirmed("e", { id: "e", rev: 5 }) },
      { type: "modified", doc: pending },
    ],
  });
  expect(commit.mock.calls[0]?.[0].changes).toEqual([
    { type: "create", collection: "todos", data: { id: "a", title: "new" }, rev: 1 },
    { type: "update", collection: "todos", data: { id: "b", title: "edit" }, rev: 2 },
    { type: "delete", collection: "todos", id: "c", deletedAt: 5, rev: 3 },
    { type: "update", collection: "todos", data: { id: "d", title: "not a number" } },
    { type: "delete", collection: "todos", id: "e" },
  ]);
});

test("Firestore commits nothing for a snapshot of unconfirmed writes only", () => {
  const adapter = revisionedAdapter();
  const commit = vi.fn();
  void adapter.pull({ commitChanges: commit } as never);
  sdk.firestoreCallbacks[0]!({
    docChanges: () => [
      {
        type: "modified",
        doc: { id: "p", data: () => ({ rev: 9 }), metadata: { hasPendingWrites: true } },
      },
    ],
  });
  expect(commit).not.toHaveBeenCalled();
});

test("Firestore writes the revision and gives each write to a document its own batch", async () => {
  const commitChanges = vi.fn(async () => {});
  const events = [
    { type: "create", collection: "todos", data: { id: "a", title: "new" }, rev: 1 },
    { type: "update", collection: "todos", data: { id: "a", title: "edit" }, rev: 2 },
    { type: "update", collection: "todos", data: { id: "b", title: "other" }, rev: 7 },
    { type: "delete", collection: "todos", id: "a", deletedAt: 5, rev: 3 },
  ];
  await revisionedAdapter().push({ events, commitChanges } as never);
  expect(sdk.firestoreSets.map(([ref, data]) => [(ref as { id: string }).id, data])).toEqual([
    ["a", { id: "a", title: "new", rev: 1 }],
    ["a", { id: "a", title: "edit", rev: 2 }],
    ["b", { id: "b", title: "other", rev: 7 }],
    ["a", { deleted: true, rev: 3 }],
  ]);
  expect(commitChanges.mock.calls.map(([call]: any) => call.events)).toEqual([
    [events[0]],
    [events[1], events[2]],
    [events[3]],
  ]);
});

test("Firestore turns a refused batch into a PushConflictError with the server state", async () => {
  sdk.deniedDocument = "a";
  sdk.serverDocuments = {
    "todos/a": { id: "a", title: "theirs", rev: 4 },
    "todos/b": { id: "b", title: "same base", rev: 6 },
  };
  const commitChanges = vi.fn(async () => {});
  const error = await Promise.resolve(
    revisionedAdapter().push({
      events: [
        { type: "update", collection: "todos", data: { id: "a", title: "mine" }, rev: 2 },
        { type: "update", collection: "todos", data: { id: "b", title: "fine" }, rev: 7 },
      ],
      commitChanges,
    } as never),
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PushConflictError);
  expect((error as PushConflictError).events).toEqual([
    { type: "update", collection: "todos", data: { id: "a", title: "theirs" }, rev: 4 },
  ]);
  expect(commitChanges).not.toHaveBeenCalled();
});

test("Firestore reports a document deleted from the server as revision 0", async () => {
  sdk.deniedDocument = "a";
  const error = await Promise.resolve(
    revisionedAdapter().push({
      events: [{ type: "update", collection: "todos", data: { id: "a" }, rev: 4 }],
      commitChanges: vi.fn(),
    } as never),
  ).catch((caught: unknown) => caught);
  expect((error as PushConflictError).events).toEqual([
    { type: "delete", collection: "todos", id: "a", rev: 0 },
  ]);
});

test("Firestore rethrows the refusal when every refused document is at its expected revision", async () => {
  sdk.deniedDocument = "a";
  // A document without a revision counts as 0, like a missing one.
  sdk.serverDocuments = { "todos/b": { id: "b" } };
  await expect(
    revisionedAdapter().push({
      events: [
        { type: "create", collection: "todos", data: { id: "a" }, rev: 1 },
        { type: "update", collection: "todos", data: { id: "b" }, rev: 1 },
      ],
      commitChanges: vi.fn(),
    } as never),
  ).rejects.toBeInstanceOf(PushRejectedError);
});

test("Firestore reads no document after a refusal without revisions or of another kind", async () => {
  sdk.deniedDocument = "a";
  sdk.serverDocumentError = new Error("must not read");
  const event = { type: "update", collection: "todos", data: { id: "a" } };
  await expect(
    revisionedAdapter({ revisionField: undefined }).push({
      events: [event],
      commitChanges: vi.fn(),
    } as never),
  ).rejects.toBeInstanceOf(PushRejectedError);

  sdk.deniedDocument = undefined;
  sdk.writeError = firebaseError("unavailable");
  await expect(
    revisionedAdapter().push({
      events: [{ ...event, rev: 1 }],
      commitChanges: vi.fn(),
    } as never),
  ).rejects.toBe(sdk.writeError);
});

test("Firestore reports a failed conflict read by its own code", async () => {
  sdk.deniedDocument = "a";
  const event = { type: "update", collection: "todos", data: { id: "a" }, rev: 2 };
  const push = () => revisionedAdapter().push({ events: [event], commitChanges: vi.fn() } as never);

  sdk.serverDocumentError = firebaseError("unavailable");
  await expect(push()).rejects.toBe(sdk.serverDocumentError);
  sdk.serverDocumentError = firebaseError("permission-denied");
  await expect(push()).rejects.toBeInstanceOf(PushRejectedError);
});

function revisionedRealtime(overrides: Record<string, unknown> = {}) {
  return realtimeTodos({ revisionField: "rev", ...overrides });
}

const realtimeChild = (key: string, value: unknown) => ({ key, val: () => value });

test("Realtime Database lists only the collections with a revision field as revisioned", () => {
  const base = { createCheckpoint: () => "cp", resolveRemoteId: () => "id" };
  const adapter = createRealtimeDBSyncAdapter({
    db: {} as never,
    collections: [
      { ...base, collectionName: "todos", collectionPath: "todos", revisionField: "rev" },
      { ...base, collectionName: "notes", collectionPath: "notes" },
    ],
  } as never);
  expect(adapter.revisionedCollections).toEqual(["todos"]);
});

test("Realtime Database reads the revision of pulled children and leaves it out of the row", async () => {
  const commit = vi.fn();
  void revisionedRealtime().pull({ commitChanges: commit } as never);
  sdk.rtdbCallbacks.added![0]!(realtimeChild("a", { id: "a", title: "new", rev: 1 }));
  sdk.rtdbCallbacks.changed![0]!(realtimeChild("b", { id: "b", title: "edit", rev: 2 }));
  sdk.rtdbCallbacks.changed![0]!(realtimeChild("c", { deleted: true, deletedAt: 5, rev: 3 }));
  sdk.rtdbCallbacks.changed![0]!(realtimeChild("d", { id: "d", rev: "4" }));
  sdk.rtdbCallbacks.removed![0]!(realtimeChild("e", { id: "e", rev: 5 }));
  sdk.rtdbCallbacks.added![0]!(realtimeChild("f", "a primitive"));
  await Promise.resolve();
  expect(commit.mock.calls[0]?.[0].changes).toEqual([
    { type: "create", collection: "todos", data: { id: "a", title: "new" }, rev: 1 },
    { type: "update", collection: "todos", data: { id: "b", title: "edit" }, rev: 2 },
    { type: "delete", collection: "todos", id: "c", deletedAt: 5, rev: 3 },
    { type: "update", collection: "todos", data: { id: "d" } },
    { type: "delete", collection: "todos", id: "e" },
    { type: "create", collection: "todos", data: "a primitive" },
  ]);
});

test("Realtime Database ignores child events of a revisioned record while it is being written", async () => {
  const adapter = revisionedRealtime();
  const commit = vi.fn();
  void adapter.pull({ commitChanges: commit } as never);
  sdk.rtdbOnWrite = () => {
    sdk.rtdbCallbacks.changed![0]!(realtimeChild("a", { id: "a", title: "mine", rev: 2 }));
    sdk.rtdbCallbacks.changed![0]!(realtimeChild("b", { id: "b", title: "theirs", rev: 8 }));
  };
  await adapter.push({
    events: [{ type: "update", collection: "todos", data: { id: "a", title: "mine" }, rev: 2 }],
    commitChanges: vi.fn(async () => {}),
  } as never);
  sdk.rtdbOnWrite = undefined;
  sdk.rtdbCallbacks.changed![0]!(realtimeChild("a", { id: "a", title: "next", rev: 3 }));
  await Promise.resolve();
  expect(commit.mock.calls.flatMap(([call]) => call.changes)).toEqual([
    { type: "update", collection: "todos", data: { id: "b", title: "theirs" }, rev: 8 },
    { type: "update", collection: "todos", data: { id: "a", title: "next" }, rev: 3 },
  ]);
});

test("Realtime Database ignores only child events no newer than the revision being written", async () => {
  const adapter = revisionedRealtime();
  const commit = vi.fn();
  void adapter.pull({ commitChanges: commit } as never);
  sdk.rtdbOnWrite = () => {
    const changed = sdk.rtdbCallbacks.changed![0]!;
    // The state before the write, as a refused write restores it, with and without a revision.
    changed(realtimeChild("a", { id: "a", title: "before", rev: 1 }));
    changed(realtimeChild("a", { id: "a", title: "before" }));
    changed(realtimeChild("a", { id: "a", title: "theirs", rev: 3 }));
  };
  await adapter.push({
    events: [{ type: "update", collection: "todos", data: { id: "a", title: "mine" }, rev: 2 }],
    commitChanges: vi.fn(async () => {}),
  } as never);
  sdk.rtdbOnWrite = undefined;
  await Promise.resolve();
  expect(commit.mock.calls.flatMap(([call]) => call.changes)).toEqual([
    { type: "update", collection: "todos", data: { id: "a", title: "theirs" }, rev: 3 },
  ]);
});

test("Realtime Database still pulls child events being written without revisions", async () => {
  const adapter = realtimeTodos();
  const commit = vi.fn();
  void adapter.pull({ commitChanges: commit } as never);
  sdk.rtdbOnWrite = () => {
    sdk.rtdbCallbacks.changed![0]!(realtimeChild("a", { id: "a", title: "mine" }));
  };
  await adapter.push({
    events: [{ type: "update", collection: "todos", data: { id: "a", title: "mine" } }],
    commitChanges: vi.fn(async () => {}),
  } as never);
  sdk.rtdbOnWrite = undefined;
  await Promise.resolve();
  expect(commit).toHaveBeenCalledTimes(1);
});

test("Realtime Database writes the revision and gives each write to a record its own update", async () => {
  const commitChanges = vi.fn(async () => {});
  const events = [
    { type: "create", collection: "todos", data: { id: "a", title: "new" }, rev: 1 },
    { type: "update", collection: "todos", data: { id: "a", title: "edit" }, rev: 2 },
    { type: "update", collection: "todos", data: { id: "b", title: "other" }, rev: 7 },
    { type: "delete", collection: "todos", id: "a", deletedAt: 5, rev: 3 },
  ];
  await revisionedRealtime().push({ events, commitChanges } as never);
  expect(sdk.updates.map(([, updates]) => updates)).toEqual([
    { "todos/a": { id: "a", title: "new", rev: 1 } },
    {
      "todos/a/id": "a",
      "todos/a/title": "edit",
      "todos/a/rev": 2,
      "todos/b/id": "b",
      "todos/b/title": "other",
      "todos/b/rev": 7,
    },
    { "todos/a/deleted": true, "todos/a/rev": 3 },
  ]);
  expect(commitChanges.mock.calls.map(([call]: any) => call.events)).toEqual([
    [events[0]],
    [events[1], events[2]],
    [events[3]],
  ]);
});

test("Realtime Database writes a value that cannot hold a field without a revision", async () => {
  await revisionedRealtime({ serializeUpdate: () => "text" }).push({
    events: [{ type: "update", collection: "todos", data: { id: "a" }, rev: 2 }],
    commitChanges: vi.fn(async () => {}),
  } as never);
  expect(sdk.updates.map(([, updates]) => updates)).toEqual([{ "todos/a": "text" }]);
});

test("Realtime Database turns a refused update into a PushConflictError with the server state", async () => {
  sdk.writeError = firebaseError("PERMISSION_DENIED");
  sdk.rtdbRecords = {
    "todos/a": { id: "a", title: "theirs", rev: 4 },
    "todos/b": { id: "b", title: "same base", rev: 6 },
  };
  const commitChanges = vi.fn(async () => {});
  const error = await Promise.resolve(
    revisionedRealtime().push({
      events: [
        { type: "update", collection: "todos", data: { id: "a", title: "mine" }, rev: 2 },
        { type: "update", collection: "todos", data: { id: "b", title: "fine" }, rev: 7 },
      ],
      commitChanges,
    } as never),
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PushConflictError);
  expect((error as PushConflictError).events).toEqual([
    { type: "update", collection: "todos", data: { id: "a", title: "theirs" }, rev: 4 },
  ]);
  expect(commitChanges).not.toHaveBeenCalled();
});

test("Realtime Database reports a record removed from the server as revision 0", async () => {
  sdk.writeError = firebaseError("PERMISSION_DENIED");
  const error = await Promise.resolve(
    revisionedRealtime().push({
      events: [{ type: "update", collection: "todos", data: { id: "a" }, rev: 4 }],
      commitChanges: vi.fn(),
    } as never),
  ).catch((caught: unknown) => caught);
  expect((error as PushConflictError).events).toEqual([
    { type: "delete", collection: "todos", id: "a", rev: 0 },
  ]);
});

test("Realtime Database rethrows the refusal when every refused record is at its expected revision", async () => {
  sdk.writeError = firebaseError("PERMISSION_DENIED");
  // A record without a revision counts as 0, like a missing one.
  sdk.rtdbRecords = { "todos/b": { id: "b" } };
  await expect(
    revisionedRealtime().push({
      events: [
        { type: "create", collection: "todos", data: { id: "a" }, rev: 1 },
        { type: "update", collection: "todos", data: { id: "b" }, rev: 1 },
      ],
      commitChanges: vi.fn(),
    } as never),
  ).rejects.toBeInstanceOf(PushRejectedError);
});

test("Realtime Database keeps the refusal when the refused records cannot be read", async () => {
  sdk.writeError = firebaseError("PERMISSION_DENIED");
  sdk.rtdbGetResult = Promise.reject(new Error("Permission denied"));
  await expect(
    revisionedRealtime().push({
      events: [{ type: "update", collection: "todos", data: { id: "a" }, rev: 2 }],
      commitChanges: vi.fn(),
    } as never),
  ).rejects.toBeInstanceOf(PushRejectedError);
});

test("Realtime Database reads no record after a refusal without revisions or of another kind", async () => {
  const event = { type: "update", collection: "todos", data: { id: "a" } };
  sdk.writeError = firebaseError("PERMISSION_DENIED");
  await expect(
    realtimeTodos().push({ events: [event], commitChanges: vi.fn() } as never),
  ).rejects.toBeInstanceOf(PushRejectedError);
  expect(sdk.rtdbGets).toEqual([]);

  sdk.writeError = firebaseError("DISCONNECTED");
  await expect(
    revisionedRealtime().push({
      events: [{ ...event, rev: 1 }],
      commitChanges: vi.fn(),
    } as never),
  ).rejects.toBe(sdk.writeError);
  expect(sdk.rtdbGets).toEqual([]);
});
