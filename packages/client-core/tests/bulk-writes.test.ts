import { afterEach, expect, test, vi } from "vite-plus/test";
import { ChangeBus } from "../src/change-bus";
import { createLocalMutationSink, executeLocalMutations } from "../src/collection/local-mutation";
import { CollectionRuntime } from "../src/collection/runtime";
import { LeaderChangedError } from "../src/db-storage";
import { SyncClientImpl } from "../src/sync-client/sync-client";
import {
  atomicMemoryStore,
  clientConfig,
  collection,
  createEngine,
  makeDb,
  settle,
  storageGroup,
  tick,
} from "./helpers/storage";
import { installTabs } from "./helpers/tabs";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const notes = { name: "notes", adapterConfig: {}, primaryField: "id" };
const syncAdapter = { collections: ["todos"], push: vi.fn(async () => {}), pull: () => () => {} };

/** A client whose `todos` are synced and whose `notes` are local only. */
function client(db = makeDb()) {
  const bus = new ChangeBus<any>();
  const sync = new SyncClientImpl(
    clientConfig(db, { collections: [collection, notes], syncAdapter }),
    bus,
  ) as any;
  const published = vi.fn();
  bus.subscribe(published, { stream: "local" });
  return { db, client: sync, published, events: () => published.mock.calls.flat(2) };
}

const pending = (db: any) => db.localChangeStore.getPendingEvents();

test("upsert creates a missing record and updates an existing one", async () => {
  const { db, client: c, events } = client();
  await c.collections.todos.upsert({ id: "1", title: "a" });
  await c.collections.todos.upsert({ id: "1", title: "b" });
  expect(db.rows.get("1")).toEqual({ id: "1", title: "b" });
  expect((await pending(db)).map((e: any) => [e.type, e.data])).toEqual([
    ["create", { id: "1", title: "a" }],
    ["update", { id: "1", title: "b" }],
  ]);
  await tick();
  expect(events().map((e: any) => e.type)).toEqual(["create", "update"]);
  await c.dispose();
});

test("upsert prefers the adapter's optional read", async () => {
  const db = makeDb();
  db.getOptional = vi.fn(async () => undefined);
  const { client: c } = client(db);
  await c.collections.todos.upsert({ id: "1" });
  expect(db.getOptional).toHaveBeenCalledWith("todos", "1");
  expect(db.get).not.toHaveBeenCalled();
  expect(db.insert).toHaveBeenCalledOnce();
  await c.dispose();
});

test("bulk writes commit once, with one outbox event per record in order", async () => {
  const { db, client: c, published } = client();
  db.rows.set("2", { id: "2", title: "old" });
  await c.collections.todos.insertMany([{ id: "1" }, { id: "3" }]);
  await c.collections.todos.updateMany([{ id: "1", title: "x" }]);
  await c.collections.todos.upsertMany([{ id: "2", title: "y" }, { id: "4" }]);
  await c.collections.todos.deleteMany(["3"]);
  expect(db.commitLocalMutation).toHaveBeenCalledTimes(4);
  expect((await pending(db)).map((e: any) => `${e.type}:${e.recordId}`)).toEqual([
    "create:1",
    "create:3",
    "update:1",
    "update:2",
    "create:4",
    "delete:3",
  ]);
  const dirty = await db.localChangeStore.getDirtyRecords("todos");
  expect(dirty.map((r: any) => `${r.recordId}:${r.state}`).sort()).toEqual([
    "1:dirty",
    "2:dirty",
    "3:deleted",
    "4:dirty",
  ]);
  await tick();
  // Once per call, with all of its records.
  expect(published.mock.calls.map(([events]) => events.length)).toEqual([2, 1, 2, 1]);
  await c.dispose();
});

test("a bulk write is all or nothing, and an empty one does nothing", async () => {
  const { db, client: c, events } = client();
  db.rows.set("2", { id: "2" });
  await expect(c.collections.todos.insertMany([{ id: "1" }, { id: "2" }])).rejects.toThrow(
    "duplicate 2",
  );
  expect(await pending(db)).toEqual([]);
  await expect(c.collections.todos.insertMany([{ id: "5" }, { id: null }])).rejects.toThrow(
    TypeError,
  );
  expect(db.insert).toHaveBeenCalledTimes(2);

  await c.collections.todos.insertMany([]);
  await c.collections.todos.deleteMany([]);
  expect(db.commitLocalMutation).toHaveBeenCalledOnce();
  await tick();
  expect(events()).toEqual([]);
  await c.dispose();
});

test("live queries rerun once per bulk write", async () => {
  const { client: c } = client();
  const onData = vi.fn();
  c.liveQuery({ collections: ["todos"], query: async () => 1, onData });
  await tick();
  onData.mockClear();
  await c.collections.todos.insertMany(Array.from({ length: 50 }, (_, i) => ({ id: `${i}` })));
  await tick();
  expect(onData).toHaveBeenCalledOnce();
  await c.dispose();
});

test("a transaction commits writes of several collections together and returns its result", async () => {
  const { db, client: c, published, events } = client();
  const result = await c.transaction(async (tx: any) => {
    await tx.collections.todos.insert({ id: "t1" });
    await tx.collections.notes.upsert({ id: "n1", text: "a" });
    await tx.collections.todos.update({ id: "t1", title: "done" });
    const read = await tx.collections.todos.get("t1");
    const all = await tx.collections.notes.getMany();
    return { read, count: all.length };
  });
  expect(result).toEqual({ read: { id: "t1", title: "done" }, count: 2 });
  expect(db.commitLocalMutation).toHaveBeenCalledOnce();
  // `notes` is local only: its event is recorded as applied but never pending.
  expect((await pending(db)).map((e: any) => `${e.type}:${e.recordId}`)).toEqual([
    "create:t1",
    "update:t1",
  ]);
  expect(await db.localChangeStore.getDirtyRecords("notes")).toEqual([]);
  await tick();
  expect(published).toHaveBeenCalledOnce();
  expect(events().map((e: any) => `${e.collection}:${e.type}`)).toEqual([
    "todos:create",
    "notes:create",
    "todos:update",
  ]);
  await c.dispose();
});

test("a transaction that throws saves no outbox event and publishes nothing", async () => {
  const { db, client: c, events } = client();
  await expect(
    c.transaction(async (tx: any) => {
      await tx.collections.todos.insert({ id: "t1" });
      throw new Error("abort");
    }),
  ).rejects.toThrow("abort");
  expect(await pending(db)).toEqual([]);
  await tick();
  expect(events()).toEqual([]);
  await c.dispose();
});

test("a transaction cut short by a leader change is retried, never applied twice", async () => {
  const { db, client: c } = client();
  const commit = db.commitLocalMutation.getMockImplementation();
  const fn = vi.fn(async (tx: any) => {
    await tx.collections.todos.upsert({ id: "t1", title: `run ${fn.mock.calls.length}` });
    return fn.mock.calls.length;
  });

  // Rolled back: run again.
  db.commitLocalMutation.mockRejectedValueOnce(new LeaderChangedError());
  expect(await c.transaction(fn)).toBe(1);
  expect(fn).toHaveBeenCalledOnce();

  // Committed, acknowledgement lost: the first attempt's result, not a second run.
  fn.mockClear();
  db.commitLocalMutation.mockImplementationOnce(async (options: any) => {
    await commit(options);
    throw new LeaderChangedError();
  });
  expect(await c.transaction(fn)).toBe(1);
  expect(fn).toHaveBeenCalledOnce();
  expect((await pending(db)).map((e: any) => e.type)).toEqual(["create", "update"]);

  // Nothing written: no event to prove a commit, so it runs again.
  const read = vi.fn(async () => "read");
  db.commitLocalMutation.mockImplementationOnce(async (options: any) => {
    await commit(options);
    throw new LeaderChangedError();
  });
  expect(await c.transaction(read)).toBe("read");
  expect(read).toHaveBeenCalledTimes(2);
  await c.dispose();
});

test("a follower's bulk write and transaction reach the shared outbox", async () => {
  installTabs();
  const rows = createEngine();
  const store = atomicMemoryStore();
  const group = storageGroup();
  const leader = client(makeDb(rows, store, group.join()));
  const follower = client(makeDb(rows, store, group.join()));
  await settle();
  expect(follower.client.role).toBe("follower");
  const remote = vi.fn();
  leader.client.subscribe(remote, { stream: "remote" });
  await follower.client.collections.todos.insertMany([{ id: "1" }, { id: "2" }]);
  await follower.client.transaction(async (tx: any) => tx.collections.todos.deleteMany(["1"]));
  await settle();
  expect([...rows.keys()]).toEqual(["2"]);
  expect((await store.getPendingEvents()).map((e: any) => e.type)).toEqual([
    "create",
    "create",
    "delete",
  ]);
  expect(remote.mock.calls.flat(2)).toHaveLength(3);
  await Promise.all([leader.client.dispose(), follower.client.dispose()]);
});

test("the runtime and sink apply a batch in order and report it as applied", async () => {
  const db = makeDb();
  const store = atomicMemoryStore();
  const sink = createLocalMutationSink(db, store);
  const base = { collection: "todos", createdAt: 1 };
  const outcome = await sink.commit(async (writer) => {
    const applied = await writer.apply([
      { ...base, type: "upsert", id: "1", recordId: "1", eventId: "e1", data: { id: "1" } },
      { ...base, type: "delete", id: "1", recordId: "1", eventId: "e2" },
    ]);
    return applied.map((m) => m.type);
  });
  expect(outcome.result).toEqual(["create", "delete"]);
  expect(outcome.applied.map((m) => m.eventId)).toEqual(["e1", "e2"]);

  const runtime = new CollectionRuntime(
    collection as never,
    { resolve: async () => ({ dbAdapter: db, mutations: sink }) },
    new ChangeBus<any>(),
  );
  await runtime.upsertMany([{ id: "2" }] as never);
  expect(db.rows.has("2")).toBe(true);
});

test("local-only mutations of a batch leave no pending event or dirty record", async () => {
  const db = makeDb();
  const store = atomicMemoryStore();
  const base = { createdAt: 1, type: "create" as const };
  await executeLocalMutations(
    db,
    store,
    (writer) =>
      writer.apply([
        { ...base, collection: "todos", id: "1", recordId: "1", eventId: "e1", data: { id: "1" } },
        { ...base, collection: "notes", id: "2", recordId: "2", eventId: "e2", data: { id: "2" } },
      ]),
    { localOnly: (name) => name === "notes" },
  );
  expect((await store.getPendingEvents()).map((e: any) => e.id)).toEqual(["e1"]);
  expect(await store.hasAppliedEvent("e2")).toBe(true);
  expect(await store.getDirtyRecords("notes")).toEqual([]);
});
