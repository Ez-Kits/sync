import { afterEach, expect, test, vi } from "vite-plus/test";
import { ChangeBus } from "../src/change-bus";
import { CollectionRuntime } from "../src/collection/runtime";
import { createMemoryLocalChangeStore } from "../src/local-change-store/memory";
import { SyncClientImpl } from "../src/sync-client/sync-client";

type Config = { name: "todos"; adapterConfig: {}; primaryField: "id" };
const config: Config = { name: "todos", adapterConfig: {}, primaryField: "id" };
const makeDb = () => {
  const rows = new Map<string, { id: string; title?: string }>();
  const db = {
    queryBuilder: {},
    querySchema: { todos: {} },
    insert: vi.fn(async (_n: string, row: { id: string; title?: string }) => {
      rows.set(row.id, row);
    }),
    update: vi.fn(async (_n: string, row: { id: string; title?: string }) => {
      rows.set(row.id, row);
    }),
    delete: vi.fn(async (_n: string, id: string) => {
      rows.delete(id);
    }),
    get: vi.fn(async (_n: string, id: string) => rows.get(id)),
    getMany: vi.fn(async () => [...rows.values()]),
    transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(db)),
  };
  return db;
};

afterEach(() => vi.restoreAllMocks());

test("collection runtime persists outbox and dirty records before publishing, and delegates reads", async () => {
  const db = makeDb();
  const store = createMemoryLocalChangeStore();
  const bus = new ChangeBus<any>();
  const listener = vi.fn();
  bus.subscribe(listener, { stream: "local" });
  const runtime = new CollectionRuntime(config as never, db as never, bus, store);
  await runtime.insert({ id: "1", title: "a" } as never);
  await runtime.update({ id: "1", title: "b" } as never);
  await runtime.delete("1" as never);
  await runtime.get("1" as never);
  await runtime.getMany();
  await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
  expect(await store.getPendingEvents("todos")).toHaveLength(3);
  expect((await store.getDirtyRecords("todos"))[0]?.state).toBe("deleted");
  expect(listener.mock.calls.flatMap(([events]) => (events as any[]).map((e) => e.type))).toEqual([
    "create",
    "update",
    "delete",
  ]);
  expect(db.insert).toHaveBeenCalledWith("todos", { id: "1", title: "a" });
  expect(db.get).toHaveBeenCalledWith("todos", "1");
  expect(db.getMany).toHaveBeenCalledWith("todos");
});

test("collection runtime uses atomic adapter commit and stops before persisting when mutation fails", async () => {
  const db = makeDb() as ReturnType<typeof makeDb> & {
    commitLocalMutation: ReturnType<typeof vi.fn>;
  };
  db.commitLocalMutation = vi.fn(
    async ({
      mutate,
      persistOutboxEvent,
    }: {
      mutate: () => Promise<void>;
      persistOutboxEvent: () => Promise<void>;
    }) => {
      await mutate();
      await persistOutboxEvent();
    },
  );
  const runtime = new CollectionRuntime(
    config as never,
    db as never,
    new ChangeBus<any>(),
    createMemoryLocalChangeStore(),
  );
  await runtime.insert({ id: "atomic" } as never);
  expect(db.commitLocalMutation).toHaveBeenCalledOnce();
  db.insert.mockRejectedValueOnce(new Error("db failure"));
  await expect(runtime.insert({ id: "bad" } as never)).rejects.toThrow("db failure");
});

test("sync client supports query subscriptions, checkpoint APIs, status listeners, and disposal", async () => {
  const db = makeDb();
  const statuses: string[] = [];
  const client = new SyncClientImpl(
    {
      collections: [config],
      dbAdapter: () => db as never,
      checkpointStorage: {
        getCheckpoint: vi.fn(async () => undefined),
        saveCheckpoint: vi.fn(async () => {}),
      },
      localChangeStore: createMemoryLocalChangeStore(),
      coordinateTabs: false,
      onSyncStatus: (e: any) => statuses.push(e.status),
    } as never,
    db as never,
    new ChangeBus<any>() as never,
  );
  const statusEvents: string[] = [];
  const unsubStatus = client.subscribeStatus((e) => statusEvents.push(e.status));
  const onData = vi.fn();
  const unsubscribe = client.liveQuery({
    collections: ["todos"],
    query: async () => [1],
    onData,
  } as never);
  await Promise.resolve();
  expect(onData).toHaveBeenCalledWith([1]);
  expect(await client.getCheckpoint("todos" as never)).toBeUndefined();
  await client.saveCheckpoint("todos" as never, 4 as never);
  client.startSync();
  expect(statuses).toContain("syncing");
  expect(statusEvents[0]).toBe("stopped");
  unsubscribe();
  unsubStatus();
  client.dispose();
  expect(statuses.at(-1)).toBe("stopped");
});

test("sync client handles offline state and subscribe overload validation", () => {
  const db = makeDb();
  const prior = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: false } });
  try {
    const client = new SyncClientImpl(
      {
        collections: [config],
        dbAdapter: () => db as never,
        checkpointStorage: {
          getCheckpoint: vi.fn(async () => undefined),
          saveCheckpoint: vi.fn(async () => {}),
        },
        localChangeStore: createMemoryLocalChangeStore(),
      } as never,
      db as never,
      new ChangeBus<any>() as never,
    );
    const statuses: string[] = [];
    client.subscribeStatus((e) => statuses.push(e.status));
    client.startSync();
    expect(statuses).toContain("offline");
    expect(() => (client.subscribe as (...args: unknown[]) => unknown)()).toThrow(TypeError);
    client.dispose();
  } finally {
    if (prior) Object.defineProperty(globalThis, "navigator", prior);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});
