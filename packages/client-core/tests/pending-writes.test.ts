import { afterEach, expect, test, vi } from "vite-plus/test";
import { ChangeBus } from "../src/change-bus";
import { WaitForPushedError } from "../src/sync-client";
import { SyncClientImpl } from "../src/sync-client/sync-client";
import { PushRejectedError } from "../src/sync-handler";
import {
  atomicMemoryStore,
  clientConfig,
  collection,
  createEngine,
  makeDb,
  settle,
  storageGroup,
} from "./helpers/storage";
import { FakeBroadcastChannel, installTabs } from "./helpers/tabs";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const notes = { ...collection, name: "notes" };

function client(dbAdapter: unknown, extra: Record<string, unknown> = {}) {
  return new SyncClientImpl(
    clientConfig(dbAdapter, { collections: [collection, notes], ...extra }),
    new ChangeBus<any>() as never,
  );
}

/** Accepts pushes, except of rows whose id is in `denied`; holds them while `hold` is set. */
function provider() {
  const denied = new Set<string>();
  let hold: Promise<void> | undefined;
  const adapter = {
    denied,
    push: vi.fn(async ({ events, commitChanges }: any) => {
      if (hold) await hold;
      if (events.some((event: any) => denied.has(event.data?.id))) {
        throw new PushRejectedError("permission-denied");
      }
      await commitChanges({ events });
    }),
    pull: vi.fn(() => () => {}),
    holdPushes() {
      let release!: () => void;
      hold = new Promise<void>((resolve) => (release = resolve));
      return () => {
        hold = undefined;
        release();
      };
    },
  };
  return adapter;
}

function tabs() {
  installTabs();
  const rows = createEngine();
  const store = atomicMemoryStore();
  const group = storageGroup();
  return { store, adapter: () => makeDb(rows, store, group.join()) };
}

function record(syncClient: {
  subscribePendingWrites: SyncClientImpl<any, any, any>["subscribePendingWrites"];
}) {
  const seen: Array<{ total: number; rejected: number; byCollection: object }> = [];
  const stop = syncClient.subscribePendingWrites((pending) => seen.push(pending));
  return { seen, stop, last: () => seen.at(-1) };
}

test("pending writes count the outbox before sync starts, per collection, and drop as pushes are confirmed", async () => {
  const adapter = provider();
  const syncClient = client(makeDb(), { syncAdapter: adapter });
  const observed = record(syncClient);
  await settle();
  expect(observed.seen).toEqual([{ total: 0, rejected: 0, byCollection: {} }]);

  await syncClient.collections.todos.insert({ id: "t1" } as never);
  await syncClient.collections.todos.update({ id: "t1", title: "b" } as never);
  await syncClient.collections.notes.insert({ id: "n1" } as never);
  await settle();
  // Events, not records: two writes to t1 count twice.
  const expected = { total: 3, rejected: 0, byCollection: { todos: 2, notes: 1 } };
  expect(observed.last()).toEqual(expected);
  expect(await syncClient.getPendingWrites()).toEqual(expected);

  syncClient.startSync();
  await expect(syncClient.waitForPushed({ timeoutMs: 1_000 })).resolves.toBeUndefined();
  await settle();
  expect(observed.last()).toEqual({ total: 0, rejected: 0, byCollection: {} });

  observed.stop();
  await syncClient.collections.todos.insert({ id: "t2" } as never);
  await settle();
  expect(observed.last()).toEqual({ total: 0, rejected: 0, byCollection: {} });
  await syncClient.dispose();
});

test("parked writes count as rejected, waitForPushed ignores them, and discard removes them", async () => {
  const adapter = provider();
  adapter.denied.add("denied");
  const onPushRejected = vi.fn();
  const syncClient = client(makeDb(), { syncAdapter: adapter, onPushRejected });
  const observed = record(syncClient);
  await syncClient.collections.todos.insert({ id: "denied" } as never);
  await syncClient.collections.todos.insert({ id: "ok" } as never);
  syncClient.startSync();

  await syncClient.waitForPushed({ timeoutMs: 1_000 });
  await settle();
  expect(observed.last()).toEqual({ total: 1, rejected: 1, byCollection: { todos: 1 } });

  await onPushRejected.mock.calls[0]![0].discard();
  await settle();
  expect(observed.last()).toEqual({ total: 0, rejected: 0, byCollection: {} });
  await syncClient.dispose();
});

test("followers count every context's writes and learn the leader's parked writes", async () => {
  const fixture = tabs();
  const adapter = provider();
  adapter.denied.add("denied");
  const leader = client(fixture.adapter(), { syncAdapter: adapter });
  const follower = client(fixture.adapter(), { syncAdapter: adapter });
  const observed = record(follower);
  await settle();

  const release = adapter.holdPushes();
  leader.startSync();
  await follower.collections.todos.insert({ id: "denied" } as never);
  await leader.collections.todos.insert({ id: "ok" } as never);
  await settle();
  expect(observed.last()).toEqual({ total: 2, rejected: 0, byCollection: { todos: 2 } });

  release();
  await vi.waitFor(() =>
    expect(observed.last()).toEqual({ total: 1, rejected: 1, byCollection: { todos: 1 } }),
  );
  await expect(follower.waitForPushed({ timeoutMs: 1_000 })).resolves.toBeUndefined();

  // A context that opens later asks the leader for its parked writes.
  const late = client(fixture.adapter());
  await settle();
  expect(FakeBroadcastChannel.messages("state-request").length).toBeGreaterThan(0);
  expect(await late.getPendingWrites()).toEqual({
    total: 1,
    rejected: 1,
    byCollection: { todos: 1 },
  });
  await Promise.all([leader.dispose(), follower.dispose(), late.dispose()]);
});

test("waitForPushed rejects on timeout, when writes are pending offline, and on dispose", async () => {
  const adapter = provider();
  const syncClient = client(makeDb(), { syncAdapter: adapter });

  // Nothing pending: resolves even offline.
  vi.stubGlobal("navigator", { onLine: false });
  await expect(syncClient.waitForPushed()).resolves.toBeUndefined();

  await syncClient.collections.todos.insert({ id: "t1" } as never);
  const offline = await syncClient.waitForPushed().catch((error: unknown) => error);
  expect(offline).toBeInstanceOf(WaitForPushedError);
  expect(offline).toMatchObject({
    reason: "offline",
    pending: { total: 1, rejected: 0, byCollection: { todos: 1 } },
  });
  vi.unstubAllGlobals();

  // Sync never started: nothing pushes.
  await expect(syncClient.waitForPushed({ timeoutMs: 20 })).rejects.toMatchObject({
    reason: "timeout",
  });

  const disposed = syncClient.waitForPushed();
  await syncClient.dispose();
  await expect(disposed).rejects.toMatchObject({ reason: "disposed" });
});

test("reads coalesce while a bulk write runs, and fall back to getPendingEvents", async () => {
  const store = atomicMemoryStore();
  delete (store as { getPendingEventKeys?: unknown }).getPendingEventKeys;
  const read = vi.spyOn(store, "getPendingEvents");
  const syncClient = client(makeDb(undefined, store), { syncAdapter: provider() });
  const observed = record(syncClient);
  await settle();
  read.mockClear();

  await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      syncClient.collections.todos.insert({ id: `t${index}` } as never),
    ),
  );
  await settle();
  expect(observed.last()).toMatchObject({ total: 50 });
  expect(read.mock.calls.length).toBeLessThan(50);
  await syncClient.dispose();
});
