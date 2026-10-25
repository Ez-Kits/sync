import { expect, test, vi } from "vite-plus/test";
import { ChangeBus } from "../src/change-bus";
import { BaseSyncHandler } from "../src/sync-handler/base-sync-handler";
import { createTestLocalChangeStore } from "./helpers/local-change-store";

const collection = { name: "todos", adapterConfig: {}, primaryField: "id" };
function fixture(overrides: Record<string, unknown> = {}) {
  const db = {
    insert: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    get: vi.fn(async (): Promise<{ id: number } | undefined> => ({ id: 1 })),
    getOptional: vi.fn(async (): Promise<{ id: number } | undefined> => ({ id: 1 })),
    getMany: vi.fn(async () => []),
    transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(db)),
  };
  const checkpointStorage = {
    getCheckpoint: vi.fn(async (_name: string): Promise<unknown> => undefined),
    saveCheckpoint: vi.fn(async () => {}),
  };
  const localChangeStore = createTestLocalChangeStore();
  const config = {
    collections: [collection],
    db,
    changeBus: new ChangeBus<any>(),
    checkpointStorage,
    localChangeStore,
    ...overrides,
  };
  class Harness extends BaseSyncHandler<any, any, any> {
    apply(event: any, target?: any) {
      return this.applyAnyCollectionEvent(event, target);
    }
    resolve(event: any) {
      return this.resolveRemoteEvent(event);
    }
    collect(name = "todos") {
      return this.collectPendingPushEvents(name);
    }
    collectAll() {
      return this.collectAllPendingPushEvents();
    }
    ack(events: any[]) {
      return this.ackPushedEvents(events);
    }
    read() {
      return this.readCheckpointMap();
    }
    save(checkpoints: any) {
      return this.saveCheckpointMap(checkpoints);
    }
    push(key: string, fn: () => void | Promise<void>, signal?: AbortSignal) {
      return this.enqueuePush(key, fn, signal);
    }
  }
  return { handler: new Harness(config as never), db, checkpointStorage, localChangeStore };
}

test("base handler applies deletes, upserts existing and absent rows, and inserts without keys", async () => {
  const { handler, db } = fixture();
  await handler.apply({ type: "delete", collection: "todos", id: 1 });
  expect(db.delete).toHaveBeenCalledWith("todos", 1);
  await handler.apply({ type: "update", collection: "todos", data: { id: 1, title: "changed" } });
  expect(db.update).toHaveBeenCalledOnce();
  db.getOptional.mockResolvedValueOnce(undefined);
  await handler.apply({ type: "create", collection: "todos", data: { id: 2 } });
  expect(db.insert).toHaveBeenCalledWith("todos", { id: 2 });
  await handler.apply({ type: "create", collection: "todos", data: { title: "no id" } });
  expect(db.insert).toHaveBeenCalledWith("todos", { title: "no id" });
  await handler.apply({ type: "create", collection: "missing", data: { id: 3 } });
  expect(db.insert).toHaveBeenCalledTimes(2);
});

test("base handler propagates fallback reads and inserts only for an explicit absent result", async () => {
  const { handler, db } = fixture();
  db.getOptional = undefined as never;
  db.get.mockRejectedValueOnce(new Error("read failed"));
  await expect(
    handler.apply({ type: "update", collection: "todos", data: { id: 4 } }),
  ).rejects.toThrow("read failed");
  expect(db.insert).not.toHaveBeenCalled();
  db.get.mockResolvedValueOnce(undefined);
  await handler.apply({ type: "update", collection: "todos", data: { id: 4 } });
  expect(db.insert).toHaveBeenCalledWith("todos", { id: 4 });
  await handler.apply({ type: "update", collection: "todos", data: { title: "no id" } });
  expect(db.insert).toHaveBeenCalledTimes(2);
  db.get.mockResolvedValueOnce({ id: 8 });
  await handler.apply({ type: "update", collection: "todos", data: { id: 8, title: "exists" } });
  expect(db.update).toHaveBeenCalledWith("todos", { id: 8, title: "exists" });
});

test("base handler maps pending events and maintains dirty state after acknowledgements", async () => {
  const { handler, localChangeStore } = fixture();
  await localChangeStore.appendEvents([
    { id: "c", type: "create", collection: "todos", recordId: "1", data: { id: 1 }, createdAt: 1 },
    { id: "d", type: "delete", collection: "todos", data: null, recordId: "2", createdAt: 2 },
  ]);
  expect(await handler.collect()).toEqual([
    { type: "create", collection: "todos", data: { id: 1 }, eventId: "c" },
    { type: "delete", collection: "todos", id: 2, deletedAt: 2, eventId: "d" },
  ]);
  expect((await handler.collectAll()).length).toBe(2);
  await handler.ack([{ type: "create", collection: "todos", data: { id: 1 }, eventId: "c" }]);
  expect(await localChangeStore.getPendingEvents()).toHaveLength(1);
  expect(await localChangeStore.getDirtyRecords()).toEqual([]);
  await handler.ack([{ type: "delete", collection: "todos", id: 2, eventId: "d" }]);
  expect(await localChangeStore.getPendingEvents()).toHaveLength(0);
});

test("acknowledging one of several changes preserves the latest dirty state", async () => {
  const { handler, localChangeStore } = fixture();
  await localChangeStore.appendEvents([
    {
      id: "old",
      type: "create",
      collection: "todos",
      recordId: "1",
      data: { id: 1 },
      createdAt: 1,
    },
    { id: "new", type: "delete", collection: "todos", data: null, recordId: "1", createdAt: 2 },
  ]);
  await localChangeStore.upsertDirtyRecord({
    collection: "todos",
    recordId: "1",
    state: "dirty",
    updatedAt: 1,
  });
  await handler.ack([{ type: "create", collection: "todos", data: { id: 1 }, eventId: "old" }]);
  expect(await localChangeStore.getPendingEvents()).toHaveLength(1);
  expect((await localChangeStore.getDirtyRecords())[0]?.state).toBe("deleted");
});

test("acknowledging an older event keeps the latest dirty record state", async () => {
  const { handler, localChangeStore } = fixture();
  await localChangeStore.appendEvents([
    {
      id: "old",
      type: "create",
      collection: "todos",
      recordId: "1",
      data: { id: 1 },
      createdAt: 1,
    },
    {
      id: "new",
      type: "update",
      collection: "todos",
      recordId: "1",
      data: { id: 1 },
      createdAt: 2,
    },
  ]);
  await handler.ack([{ type: "create", collection: "todos", data: { id: 1 }, eventId: "old" }]);
  expect((await localChangeStore.getDirtyRecords())[0]?.state).toBe("dirty");
});

test("conflict resolution ignores clean rows and supports local, remote, merged and delete decisions", async () => {
  const { handler, localChangeStore, db } = fixture({ conflictResolver: vi.fn(() => "local") });
  const update = { type: "update", collection: "todos", data: { id: 1, title: "remote" } };
  expect(await handler.resolve(update)).toBe(update);
  await localChangeStore.upsertDirtyRecord({
    collection: "todos",
    recordId: "1",
    state: "dirty",
    updatedAt: 1,
  });
  expect(await handler.resolve(update)).toBeUndefined();
  const remoteResolver = vi.fn(() => "remote");
  const remoteHandler = fixture({ conflictResolver: remoteResolver }).handler;
  await remoteHandler["config"].localChangeStore.upsertDirtyRecord({
    collection: "todos",
    recordId: "1",
    state: "dirty",
    updatedAt: 1,
  });
  expect(await remoteHandler.resolve(update)).toBe(update);
  const mergeHandler = fixture({
    conflictResolver: () => ({ data: { id: 1, title: "merged" } }),
  }).handler;
  await mergeHandler["config"].localChangeStore.upsertDirtyRecord({
    collection: "todos",
    recordId: "1",
    state: "dirty",
    updatedAt: 1,
  });
  expect(await mergeHandler.resolve(update)).toEqual({
    ...update,
    data: { id: 1, title: "merged" },
  });
  const deleteEvent = { type: "delete", collection: "todos", id: 1 };
  expect(await mergeHandler.resolve(deleteEvent)).toEqual({
    type: "update",
    collection: "todos",
    data: { id: 1, title: "merged" },
  });
  db.getOptional.mockRejectedValueOnce(new Error("read unavailable"));
  await localChangeStore.upsertDirtyRecord({
    collection: "todos",
    recordId: "1",
    state: "dirty",
    updatedAt: 2,
  });
  await expect(handler.resolve(update)).rejects.toThrow("read unavailable");
});

test("conflict resolution considers pending outbox writes and checkpoints only defined entries", async () => {
  const { handler, localChangeStore, checkpointStorage } = fixture({
    conflictResolver: ({ local }: any) => (local ? "local" : "remote"),
  });
  await localChangeStore.appendEvents([
    { id: "e", type: "update", collection: "todos", recordId: "5", data: {}, createdAt: 1 },
  ]);
  const event = { type: "update", collection: "todos", data: { id: 5 } };
  expect(await handler.resolve(event)).toBeUndefined();
  await localChangeStore.upsertDirtyRecord({
    collection: "todos",
    recordId: "not-numeric",
    state: "dirty",
    updatedAt: 1,
  });
  await handler.resolve({
    type: "update",
    collection: "todos",
    data: { id: "not-numeric" },
  } as never);
  checkpointStorage.getCheckpoint.mockResolvedValueOnce("cp");
  expect(await handler.read()).toEqual({ todos: "cp" });
  await handler.save({ todos: "next" });
  await handler.save({});
  expect(checkpointStorage.saveCheckpoint).toHaveBeenCalledTimes(1);
});

test("push queue serializes calls, retries indefinitely with capped delays, and stops on abort", async () => {
  vi.useFakeTimers();
  try {
    const errors: unknown[] = [];
    const success = vi.fn();
    const { handler } = fixture({
      onSyncError: (e: unknown) => errors.push(e),
      onSyncSuccess: success,
    });
    const push = vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValue(undefined);
    const first = handler.push("same", push);
    const second = handler.push("same", vi.fn());
    await vi.runAllTimersAsync();
    await Promise.all([first, second]);
    expect(push).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
    expect(success).toHaveBeenCalledTimes(2);
    const fail = vi.fn().mockRejectedValue(new Error("permanent"));
    const controller = new AbortController();
    const final = handler.push("fail", fail, controller.signal);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fail).toHaveBeenCalledTimes(6);
    controller.abort();
    await final;
  } finally {
    vi.useRealTimers();
  }
});

test("missing conflict resolver and recovered push queue both use their fallbacks", async () => {
  vi.useFakeTimers();
  try {
    const { handler } = fixture();
    const event = { type: "update", collection: "todos", data: { id: 1 } };
    expect(await handler.resolve(event)).toBe(event);
    const controller = new AbortController();
    const first = handler.push(
      "recover",
      () => Promise.reject(new Error("prior failure")),
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(250);
    controller.abort();
    await first;
    const next = handler.push("recover", vi.fn());
    await vi.runAllTimersAsync();
    await next;
    (handler as any).pushQueues.set(
      "rejected",
      Promise.reject(new Error("unexpected prior rejection")),
    );
    const recovered = handler.push("rejected", vi.fn());
    await vi.runAllTimersAsync();
    await recovered;
  } finally {
    vi.useRealTimers();
  }
});

test("conflict resolver falls back to get and missing primary-field metadata uses id", async () => {
  const noOptional = fixture({
    collections: [{ ...collection, primaryField: undefined }],
    conflictResolver: vi.fn(() => "remote"),
  });
  noOptional.db.getOptional = undefined as never;
  await noOptional.localChangeStore.upsertDirtyRecord({
    collection: "todos",
    recordId: "1",
    state: "dirty",
    updatedAt: 1,
  });
  expect(
    await noOptional.handler.resolve({ type: "update", collection: "todos", data: { id: 1 } }),
  ).toBeTruthy();
  expect(noOptional.db.get).toHaveBeenCalledWith("todos", 1);
});
