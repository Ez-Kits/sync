import { afterEach, expect, test, vi } from "vite-plus/test";
import { ChangeBus } from "../src/change-bus";
import { WaitForPulledError } from "../src/sync-client";
import { SyncClientImpl } from "../src/sync-client/sync-client";
import { PULL_COMMIT_CHUNK_SIZE } from "../src/sync-handler";
import { fixture, type Scope } from "./helpers/sync-fixture";
import {
  atomicMemoryStore,
  clientConfig,
  collection,
  createEngine,
  makeDb,
  settle,
  storageGroup,
} from "./helpers/storage";
import { installTabs } from "./helpers/tabs";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function client(dbAdapter: unknown, extra: Record<string, unknown> = {}) {
  return new SyncClientImpl(clientConfig(dbAdapter, extra), new ChangeBus<any>() as never);
}

/** An adapter whose pull streams the test drives through the options it was given. */
function pullingAdapter() {
  const streams: any[] = [];
  return {
    streams,
    stream: () => streams.at(-1),
    push: vi.fn(async ({ events, commitChanges }: any) => commitChanges({ events })),
    pull: vi.fn((options: any) => {
      streams.push(options);
      return () => {};
    }),
  };
}

const create = (id: string) => ({ type: "create", collection: "todos", data: { id } });

const todos = (syncClient: SyncClientImpl<any, any, any>) => {
  let state: any;
  syncClient.subscribePullState((next) => (state = next));
  return () => state.todos;
};

test("pull signals wait for the batches before them; caughtUp resets when the stream fails or stops", async () => {
  const adapter = pullingAdapter();
  const syncClient = client(makeDb(), { syncAdapter: adapter });
  const state = todos(syncClient);
  expect(state()).toEqual({
    available: false,
    hasRemoteData: undefined,
    caughtUp: false,
    progress: { pulled: 0, total: undefined },
    lastPulledAt: undefined,
  });
  syncClient.startSync();
  await settle();

  adapter.stream().onCount({ collection: "todos", total: 2 });
  adapter.stream().commitChanges({ changes: [create("a")], checkpoint: { todos: { at: 1 } } });
  adapter.stream().onCaughtUp();
  expect(state().caughtUp).toBe(false);
  await settle();
  expect(state()).toEqual({
    available: true,
    hasRemoteData: true,
    caughtUp: true,
    progress: { pulled: 1, total: 2 },
    lastPulledAt: expect.any(Number),
  });

  adapter.stream().onError(new Error("listener failed"));
  expect(state().caughtUp).toBe(false);
  // The stream resubscribes after its backoff and starts counting again.
  await vi.waitFor(() => expect(adapter.pull).toHaveBeenCalledTimes(2));
  expect(state()).toMatchObject({ available: true, progress: { pulled: 0, total: undefined } });
  adapter.stream().onCaughtUp();
  await settle();
  expect(state().caughtUp).toBe(true);

  syncClient.stopSync();
  expect(state()).toMatchObject({ caughtUp: false, available: true, hasRemoteData: true });
  await syncClient.dispose();
});

test("a preview makes rows available without counting them as progress", async () => {
  const adapter = pullingAdapter();
  const db = makeDb();
  const syncClient = client(db, { syncAdapter: adapter });
  const state = todos(syncClient);
  syncClient.startSync();
  await settle();

  adapter.stream().commitChanges({
    changes: [create("a"), create("b")],
    checkpoint: {},
    preview: true,
  });
  adapter.stream().onPreviewed({ collection: "todos", hasData: true });
  await settle();
  expect(state()).toMatchObject({
    available: true,
    hasRemoteData: true,
    caughtUp: false,
    progress: { pulled: 0 },
  });
  expect([...db.rows.keys()]).toEqual(["a", "b"]);
  expect(await db.localChangeStore.getCheckpoint("todos")).toBeUndefined();
  await syncClient.dispose();
});

test("an empty backend: an empty preview, then catching up with nothing pulled", async () => {
  const adapter = pullingAdapter();
  const syncClient = client(makeDb(), { syncAdapter: adapter });
  const state = todos(syncClient);
  syncClient.startSync();
  await settle();
  adapter.stream().onPreviewed({ collection: "todos", hasData: false });
  await settle();
  expect(state()).toMatchObject({ available: true, hasRemoteData: false });

  // Without a preview, catching up answers it.
  const other = client(makeDb(), { syncAdapter: pullingAdapter() });
  const otherState = todos(other);
  other.startSync();
  await settle();
  (other as any).config.syncAdapter.stream().onCaughtUp();
  await settle();
  expect(otherState()).toMatchObject({ available: true, hasRemoteData: false, caughtUp: true });
  await Promise.all([syncClient.dispose(), other.dispose()]);
});

test("a collection pulled before on this device is available before sync starts", async () => {
  const store = atomicMemoryStore();
  await store.saveCheckpoint("todos", '{"at":1}');
  const syncClient = client(makeDb(undefined, store), { syncAdapter: pullingAdapter() });
  const state = todos(syncClient);
  await settle();
  expect(state()).toMatchObject({ available: true, hasRemoteData: true, caughtUp: false });
  await expect(syncClient.waitForPulled({ until: "available" })).resolves.toBeUndefined();
  await syncClient.dispose();
});

test("waitForPulled waits for available or caughtUp and rejects on timeout, stop, dispose and unpulled collections", async () => {
  const adapter = pullingAdapter();
  const syncClient = client(makeDb(), { syncAdapter: adapter });
  syncClient.startSync();
  await settle();

  const available = syncClient.waitForPulled({ until: "available" });
  const caughtUp = syncClient.waitForPulled({ collections: ["todos"] as never });
  adapter.stream().onPreviewed({ collection: "todos", hasData: true });
  await expect(available).resolves.toBeUndefined();
  adapter.stream().onCaughtUp();
  await expect(caughtUp).resolves.toBeUndefined();

  await expect(syncClient.waitForPulled({ collections: ["nope"] as never })).rejects.toThrow(
    'Collection "nope" is not pulled',
  );

  syncClient.stopSync();
  const timedOut = await syncClient.waitForPulled({ timeoutMs: 10 }).catch((error) => error);
  expect(timedOut).toBeInstanceOf(WaitForPulledError);
  expect(timedOut).toMatchObject({ reason: "timeout", state: { todos: { caughtUp: false } } });

  syncClient.startSync();
  const stopped = syncClient.waitForPulled();
  syncClient.stopSync();
  await expect(stopped).rejects.toMatchObject({ reason: "stopped" });

  const disposed = syncClient.waitForPulled();
  await syncClient.dispose();
  await expect(disposed).rejects.toMatchObject({ reason: "disposed" });
});

test("every context shows the leader's pull state, also one that opens later", async () => {
  installTabs();
  const rows = createEngine();
  const store = atomicMemoryStore();
  const group = storageGroup();
  const adapter = pullingAdapter();
  // Pulled before: every context marks it available itself; only the leader sends its state.
  await store.saveCheckpoint("todos", '{"at":0}');
  const leader = client(makeDb(rows, store, group.join()), { syncAdapter: adapter });
  const follower = client(makeDb(rows, store, group.join()), { syncAdapter: adapter });
  const followerState = todos(follower);
  leader.startSync();
  await settle();

  adapter.stream().commitChanges({ changes: [create("a")], checkpoint: { todos: { at: 1 } } });
  adapter.stream().onCaughtUp();
  await vi.waitFor(() => expect(followerState().caughtUp).toBe(true));
  expect(followerState().progress.pulled).toBe(1);

  const late = client(makeDb(rows, store, group.join()), { syncAdapter: adapter });
  const lateState = todos(late);
  await vi.waitFor(() => expect(lateState().caughtUp).toBe(true));
  await Promise.all([leader.dispose(), follower.dispose(), late.dispose()]);
});

test("a large pulled batch commits in chunks, announcing each, with the checkpoint in the last", async () => {
  const adapter = pullingAdapter();
  const db = makeDb();
  const syncClient = client(db, { syncAdapter: adapter });
  const state = todos(syncClient);
  const log: string[] = [];
  syncClient.subscribe((events) => log.push(`applied ${events.length}`), { stream: "remote" });
  const saveCheckpoint = db.localChangeStore.saveCheckpoint.bind(db.localChangeStore);
  vi.spyOn(db.localChangeStore, "saveCheckpoint").mockImplementation(async (...args: any[]) => {
    log.push("checkpoint");
    return saveCheckpoint(...args);
  });
  syncClient.startSync();
  await settle();

  const total = PULL_COMMIT_CHUNK_SIZE * 2 + 50;
  const changes = Array.from({ length: total }, (_, index) => create(`r${index}`));
  adapter.stream().commitChanges({ changes, checkpoint: { todos: { at: 1 } } });
  await vi.waitFor(() => expect(db.rows.size).toBe(total));
  expect(log).toEqual([
    `applied ${PULL_COMMIT_CHUNK_SIZE}`,
    `applied ${PULL_COMMIT_CHUNK_SIZE}`,
    "checkpoint",
    "applied 50",
  ]);
  expect(state().progress.pulled).toBe(total);
  await syncClient.dispose();
});

test("a stream that ends between chunks stops there, without saving the checkpoint", async () => {
  const adapter = pullingAdapter();
  const db = makeDb();
  const syncClient = client(db, { syncAdapter: adapter });
  syncClient.startSync();
  await settle();
  syncClient.subscribe(() => syncClient.stopSync(), { stream: "remote" });

  const changes = Array.from({ length: PULL_COMMIT_CHUNK_SIZE + 10 }, (_, index) =>
    create(`r${index}`),
  );
  adapter.stream().commitChanges({ changes, checkpoint: { todos: { at: 1 } } });
  await settle(8);
  expect(db.rows.size).toBe(PULL_COMMIT_CHUNK_SIZE);
  expect(await db.localChangeStore.getCheckpoint("todos")).toBeUndefined();
  await syncClient.dispose();
});

test("signals of an ended stream, and of collections it does not pull, change nothing", async () => {
  const adapter = pullingAdapter();
  const syncClient = client(makeDb(), { syncAdapter: adapter });
  syncClient.startSync();
  await settle();
  const ended = adapter.stream();
  ended.onError(new Error("listener failed"));
  ended.onCaughtUp();
  ended.onPreviewed({ collection: "todos", hasData: true });
  await settle();
  expect(syncClient.getPullState().todos).toMatchObject({ available: false, caughtUp: false });

  await vi.waitFor(() => expect(adapter.pull).toHaveBeenCalledTimes(2));
  const before = syncClient.getPullState();
  adapter.stream().onCaughtUp(["nope"]);
  await settle();
  expect(syncClient.getPullState()).toBe(before);
  await syncClient.dispose();
});

test("a collection with its own adapter reports its pull through its own queue", async () => {
  const adapter = pullingAdapter();
  const syncClient = client(makeDb(), {
    collections: [{ ...collection, syncAdapter: adapter }],
  });
  const state = todos(syncClient);
  syncClient.startSync();
  await settle();

  // A signal before any batch, then one queued behind a batch.
  adapter.stream().onCount({ collection: "todos", total: 1 });
  adapter.stream().commitChanges({ changes: [create("a")], checkpoint: { todos: { at: 1 } } });
  adapter.stream().onCaughtUp();
  await settle();
  expect(state()).toMatchObject({ caughtUp: true, progress: { pulled: 1, total: 1 } });
  syncClient.stopSync();
  expect(state().caughtUp).toBe(false);
  await syncClient.dispose();
});

for (const scope of ["global", "collection"] as Scope[]) {
  test(`${scope}: a failing pull state observer does not block the batches after it`, async () => {
    const onPullState = vi.fn((_collection: string, event: { type: string }) => {
      if (event.type === "caughtUp") throw new Error("observer failed");
    });
    const f = fixture(scope, { onPullState });
    f.start();
    await settle();
    const options = f.streams[0]!.options;
    options.onCaughtUp();
    options.commitChanges({
      changes: [{ type: "create", collection: "todos", data: { id: 1, title: "a" } }],
      checkpoint: { todos: 1 },
    });
    await vi.waitFor(() => expect(f.rows.get("1")).toEqual({ id: 1, title: "a" }));
    expect(onPullState).toHaveBeenCalledWith(
      "todos",
      expect.objectContaining({ type: "committed" }),
    );
    f.stop();
  });
}

test("a handler replaced mid-commit no longer reports its pull or outbox", async () => {
  const adapter = pullingAdapter();
  const db = makeDb();
  const syncClient = client(db, { syncAdapter: adapter });
  await syncClient.collections.todos.insert({ id: "local" } as never);
  const apply = db.transaction.getMockImplementation();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  db.transaction.mockImplementation(async (fn: any) => {
    await gate;
    return apply(fn);
  });
  syncClient.startSync();
  await settle();
  // The push acknowledgement and the pulled batch wait in their transactions.
  adapter.stream().commitChanges({ changes: [create("a")], checkpoint: { todos: { at: 1 } } });
  await settle();
  expect(adapter.push).toHaveBeenCalled();

  db.dbStorage.setRole("follower");
  release();
  await settle();
  expect(syncClient.getPullState().todos).toMatchObject({
    progress: { pulled: 0 },
    lastPulledAt: undefined,
  });
  await syncClient.dispose();
});
