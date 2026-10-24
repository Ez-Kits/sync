import { expect, test, vi } from "vite-plus/test";
import { ChangeBus } from "../src/change-bus";
import { createMemoryLocalChangeStore } from "../src/local-change-store/memory";
import { CollectionSyncHandler } from "../src/sync-handler/collection-sync-handler";
import { GlobalSyncHandler } from "../src/sync-handler/global-sync-handler";
import { SyncHandler } from "../src/sync-handler/sync-handler";

const collection = (syncAdapter?: any) => ({
  name: "todos",
  adapterConfig: {},
  primaryField: "id",
  syncAdapter,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fixture(adapter: any, overrides: Record<string, unknown> = {}) {
  const db = {
    insert: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    get: vi.fn(async () => undefined),
    getOptional: vi.fn(async () => undefined),
    getMany: vi.fn(async () => []),
    transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(db)),
  };
  const changeBus = new ChangeBus<any>();
  const localChangeStore = createMemoryLocalChangeStore();
  const checkpointStorage = {
    getCheckpoint: vi.fn(async (): Promise<unknown> => undefined),
    saveCheckpoint: vi.fn(async () => {}),
  };
  const onSyncError = vi.fn();
  const onSyncSuccess = vi.fn();
  return {
    config: {
      collections: [collection(adapter)],
      syncAdapter: adapter,
      db,
      changeBus,
      localChangeStore,
      checkpointStorage,
      onSyncError,
      onSyncSuccess,
      ...overrides,
    },
    db,
    changeBus,
    localChangeStore,
    checkpointStorage,
    onSyncError,
    onSyncSuccess,
  };
}

test("collection handler flushes pending events, pulls checkpoints, commits remote changes, pushes local changes, and stops", async () => {
  let pullOptions: any;
  const cleanup = vi.fn();
  const pushed: any[] = [];
  const adapter = {
    push: vi.fn(async ({ events, commitChanges }: any) => {
      pushed.push(...events);
      commitChanges({ events });
    }),
    pull: vi.fn((options: any) => {
      pullOptions = options;
      return cleanup;
    }),
  };
  const f = fixture(adapter);
  f.checkpointStorage.getCheckpoint.mockResolvedValue("existing-checkpoint");
  await f.localChangeStore.appendEvents([
    {
      id: "offline",
      type: "create",
      collection: "todos",
      recordId: "1",
      data: { id: 1 },
      createdAt: 1,
    },
  ]);
  const handler = new CollectionSyncHandler(f.config as never);
  handler.start("unknown" as never);
  handler.start("todos" as never);
  handler.start("todos" as never);
  await tick();
  await tick();
  expect(adapter.push).toHaveBeenCalledOnce();
  expect(pushed[0]).toMatchObject({ type: "create", eventId: "offline" });
  expect(await f.localChangeStore.getPendingEvents()).toEqual([]);
  expect(adapter.pull).toHaveBeenCalledOnce();
  expect(pullOptions.checkpoint).toEqual({ todos: "existing-checkpoint" });
  pullOptions.commitChanges({
    changes: [{ type: "create", collection: "todos", data: { id: 2 } }],
    checkpoint: { todos: "cp" },
  });
  await tick();
  await tick();
  expect(f.db.insert).toHaveBeenCalledWith("todos", { id: 2 });
  expect(f.checkpointStorage.saveCheckpoint).toHaveBeenCalledWith("todos", "cp");
  await f.localChangeStore.appendEvents([
    {
      id: "live",
      type: "update",
      collection: "todos",
      recordId: "3",
      data: { id: 3 },
      createdAt: 2,
    },
  ]);
  f.changeBus.publishLocal({ type: "update", collection: "todos", data: { id: 3 } } as never);
  await tick();
  await tick();
  expect(adapter.push).toHaveBeenCalledTimes(2);
  f.changeBus.publishLocal({ type: "update", collection: "todos", data: { id: 3 } } as never);
  await tick();
  await tick();
  expect(adapter.push).toHaveBeenCalledTimes(2);
  handler.stop("todos" as never);
  expect(cleanup).toHaveBeenCalledOnce();
  handler.stopAll();
});

test("collection handler handles missing adapters, pull errors, and database failures", async () => {
  const onSyncError = vi.fn();
  const f = fixture(undefined, { onSyncError });
  const handler = new CollectionSyncHandler(f.config as never);
  handler.start("todos" as never);
  handler.start("missing" as never);
  const failedAdapter = {
    push: vi.fn(async () => {}),
    pull: vi.fn(async () => {
      throw new Error("pull failed");
    }),
  };
  const bad = new CollectionSyncHandler(fixture(failedAdapter, { onSyncError }).config as never);
  bad.start("todos" as never);
  await tick();
  await tick();
  expect(onSyncError).toHaveBeenCalledWith(expect.objectContaining({ message: "pull failed" }));

  const failingDb = fixture(
    {
      push: vi.fn(),
      pull: vi.fn(({ commitChanges }: any) => {
        commitChanges({
          changes: [{ type: "create", collection: "todos", data: { id: 1 } }],
          checkpoint: {},
        });
      }),
    },
    { onSyncError },
  );
  failingDb.db.transaction.mockRejectedValueOnce(new Error("transaction failed"));
  const failing = new CollectionSyncHandler(failingDb.config as never);
  failing.start("todos" as never);
  await tick();
  await tick();
  expect(onSyncError).toHaveBeenCalledWith(
    expect.objectContaining({ message: "transaction failed" }),
  );
  failing.stopAll();
});

test("collection handler reports initial flush errors and recovers pull commit queue", async () => {
  const errors: unknown[] = [];
  const badStore = createMemoryLocalChangeStore();
  vi.spyOn(badStore, "getPendingEvents").mockRejectedValueOnce(new Error("outbox read failed"));
  const failedStart = new CollectionSyncHandler(
    fixture(
      { push: vi.fn(), pull: vi.fn() },
      { localChangeStore: badStore, onSyncError: (e: unknown) => errors.push(e) },
    ).config as never,
  );
  failedStart.start("todos" as never);
  await tick();
  expect(errors).toContainEqual(expect.objectContaining({ message: "outbox read failed" }));

  let pullOptions: any;
  const f = fixture(
    {
      push: vi.fn(),
      pull: vi.fn((options: any) => {
        pullOptions = options;
      }),
    },
    { onSyncError: (e: unknown) => errors.push(e) },
  );
  const handler = new CollectionSyncHandler(f.config as never);
  handler.start("todos" as never);
  await tick();
  await tick();
  await f.localChangeStore.appendEvents([
    {
      id: "live-push",
      type: "create",
      collection: "todos",
      recordId: "9",
      data: { id: 9 },
      createdAt: 9,
    },
  ]);
  f.changeBus.publishLocal({ type: "create", collection: "todos", data: { id: 9 } } as never);
  await tick();
  await tick();
  expect((f.config.syncAdapter as any).push).toHaveBeenCalled();
  f.changeBus.publishLocal({ type: "update", collection: "todos", data: { id: 404 } } as never);
  await tick();
  await tick();
  (handler as any).pullCommitQueues.set("todos", Promise.reject(new Error("old pull failed")));
  pullOptions.commitChanges({ changes: [], checkpoint: {} });
  await tick();
  await tick();
  handler.stopAll();
});

test("stopping while initial flush is pending cancels the pending start", async () => {
  let resolve!: (events: never[]) => void;
  const store = createMemoryLocalChangeStore();
  vi.spyOn(store, "getPendingEvents").mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const adapter = { push: vi.fn(), pull: vi.fn() };
  const handler = new CollectionSyncHandler(
    fixture(adapter, { localChangeStore: store }).config as never,
  );
  handler.start("todos" as never);
  handler.stop("todos" as never);
  resolve([]);
  await tick();
  await tick();
  expect(adapter.pull).not.toHaveBeenCalled();
});

test("collection handler tolerates a change bus without unsubscribe return values", async () => {
  const f = fixture({ push: vi.fn(), pull: vi.fn() });
  const changeBus = { subscribe: vi.fn(() => undefined), publishRemoteBatch: vi.fn() };
  const handler = new CollectionSyncHandler({ ...f.config, changeBus } as never);
  handler.start("todos" as never);
  await tick();
  await tick();
  handler.stopAll();
  expect(changeBus.subscribe).toHaveBeenCalledOnce();
});

test("collection pull skips conflicts selected as local", async () => {
  let pullOptions: any;
  const f = fixture(
    {
      push: vi.fn(),
      pull: vi.fn((options: any) => {
        pullOptions = options;
      }),
    },
    { conflictResolver: () => "local" },
  );
  const handler = new CollectionSyncHandler(f.config as never);
  handler.start("todos" as never);
  await tick();
  await tick();
  await f.localChangeStore.upsertDirtyRecord({
    collection: "todos",
    recordId: "2",
    state: "dirty",
    updatedAt: 1,
  });
  pullOptions.commitChanges({
    changes: [{ type: "update", collection: "todos", data: { id: 2 } }],
    checkpoint: {},
  });
  await tick();
  await tick();
  expect(f.db.update).not.toHaveBeenCalled();
  handler.stopAll();
});

test("global handler coordinates pull and push lifecycle and the wrapper keeps startAll idempotent", async () => {
  let pullOptions: any;
  const cleanup = vi.fn();
  const adapter = {
    push: vi.fn(async ({ events, commitChanges }: any) => commitChanges({ events })),
    pull: vi.fn((options: any) => {
      pullOptions = options;
      return cleanup;
    }),
  };
  const f = fixture(adapter);
  await f.localChangeStore.appendEvents([
    { id: "pending", type: "delete", collection: "todos", recordId: "2", createdAt: 1 },
  ]);
  const global = new GlobalSyncHandler(f.config as never);
  global.start();
  global.start();
  await tick();
  await tick();
  expect(adapter.push).toHaveBeenCalledOnce();
  expect(adapter.pull).toHaveBeenCalledOnce();
  pullOptions.commitChanges({
    changes: [{ type: "delete", collection: "todos", id: 2 }],
    checkpoint: { todos: "next" },
  });
  await tick();
  await tick();
  expect(f.db.delete).toHaveBeenCalledWith("todos", 2);
  expect(f.checkpointStorage.saveCheckpoint).toHaveBeenCalledWith("todos", "next");
  global.stop();
  global.stop();
  expect(cleanup).toHaveBeenCalledOnce();

  const wrapperFixture = fixture(adapter);
  const wrapper = new SyncHandler(wrapperFixture.config as never);
  wrapper.startCollectionSync("todos" as never);
  await tick();
  await tick();
  wrapper.stopCollectionSync("todos" as never);
  wrapper.startAll();
  wrapper.startAll();
  await tick();
  await tick();
  wrapper.stopAll();
  wrapper.stopAll();
});

test("global handler reports missing adapter, callback errors, and failed remote transactions", async () => {
  const f = fixture(undefined);
  const noAdapter = new GlobalSyncHandler(f.config as never);
  noAdapter.start();
  noAdapter.stop();
  const onSyncError = vi.fn();
  const adapter = {
    push: vi.fn(async () => {
      throw new Error("push failed");
    }),
    pull: vi.fn(async () => {
      throw new Error("pull failed");
    }),
  };
  const badFixture = fixture(adapter, { onSyncError });
  const handler = new GlobalSyncHandler(badFixture.config as never);
  handler.start();
  await tick();
  await tick();
  expect(onSyncError).toHaveBeenCalledWith(expect.objectContaining({ message: "pull failed" }));
  handler.stop();
});

test("global handler pushes local events and recovers its pull commit queue", async () => {
  let pullOptions: any;
  const f = fixture({
    push: vi.fn(async ({ commitChanges }: any) => commitChanges({ events: [] })),
    pull: vi.fn((options: any) => {
      pullOptions = options;
    }),
  });
  await f.localChangeStore.appendEvents([
    {
      id: "local",
      type: "create",
      collection: "todos",
      recordId: "1",
      data: { id: 1 },
      createdAt: 1,
    },
  ]);
  const handler = new GlobalSyncHandler(f.config as never);
  handler.start();
  await tick();
  await tick();
  await f.localChangeStore.appendEvents([
    {
      id: "local",
      type: "create",
      collection: "todos",
      recordId: "1",
      data: { id: 1 },
      createdAt: 1,
    },
  ]);
  f.changeBus.publishLocal({ type: "create", collection: "todos", data: { id: 1 } } as never);
  await tick();
  await tick();
  expect((f.config.syncAdapter as any).push).toHaveBeenCalledTimes(2);
  f.changeBus.publishLocal({ type: "update", collection: "todos", data: { id: 2 } } as never);
  await tick();
  await tick();
  (handler as any).pullCommitQueue = Promise.reject(new Error("previous queue failure"));
  pullOptions.commitChanges({ changes: [], checkpoint: {} });
  f.changeBus.publishLocal({ type: "update", collection: "todos", data: { id: 1 } } as never);
  await tick();
  await tick();
  expect(f.config.syncAdapter.push).toHaveBeenCalled();
  handler.stop();
});

test("global stop cancels a pending startup and local no-op events skip empty pushes", async () => {
  let resolve!: (events: never[]) => void;
  const store = createMemoryLocalChangeStore();
  vi.spyOn(store, "getPendingEvents").mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const adapter = { push: vi.fn(), pull: vi.fn() };
  const f = fixture(adapter, { localChangeStore: store });
  const handler = new GlobalSyncHandler(f.config as never);
  handler.start();
  handler.stop();
  resolve([]);
  await tick();
  await tick();
  expect(adapter.pull).not.toHaveBeenCalled();

  const second = fixture({ push: vi.fn(), pull: vi.fn() });
  const active = new GlobalSyncHandler(second.config as never);
  active.start();
  await tick();
  await tick();
  second.changeBus.publishLocal({ type: "update", collection: "todos", data: { id: 5 } } as never);
  await tick();
  await tick();
  expect(second.config.syncAdapter!.push).not.toHaveBeenCalled();
  active.stop();
});

test("global pull skips locally selected conflicts and reports commit failures", async () => {
  let pullOptions: any;
  const onSyncError = vi.fn();
  const f = fixture(
    {
      push: vi.fn(),
      pull: vi.fn((options: any) => {
        pullOptions = options;
      }),
    },
    {
      conflictResolver: () => "local",
      onSyncError,
    },
  );
  const handler = new GlobalSyncHandler(f.config as never);
  handler.start();
  await tick();
  await tick();
  await f.localChangeStore.upsertDirtyRecord({
    collection: "todos",
    recordId: "7",
    state: "dirty",
    updatedAt: 1,
  });
  pullOptions.commitChanges({
    changes: [{ type: "update", collection: "todos", data: { id: 7 } }],
    checkpoint: {},
  });
  await tick();
  await tick();
  expect(f.db.update).not.toHaveBeenCalled();
  f.db.transaction.mockRejectedValueOnce(new Error("pull commit failed"));
  pullOptions.commitChanges({
    changes: [{ type: "create", collection: "todos", data: { id: 8 } }],
    checkpoint: {},
  });
  await tick();
  await tick();
  expect(onSyncError).toHaveBeenCalledWith(
    expect.objectContaining({ message: "pull commit failed" }),
  );
  handler.stop();
});
