import { afterEach, expect, test, vi } from "vite-plus/test";
import { ChangeBus } from "../src/change-bus";
import { createSyncClient } from "../src/sync-client/create-sync-client";
import { SyncClientImpl } from "../src/sync-client/sync-client";
import { syncChannelName } from "../src/sync-client/tab-channel";
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
import { FakeBroadcastChannel, installTabs } from "./helpers/tabs";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function recordingAdapter() {
  let commitPull: ((options: any) => void) | undefined;
  const adapter = {
    push: vi.fn(async ({ events, commitChanges }: any) => commitChanges({ events })),
    pull: vi.fn((options: any) => {
      commitPull = options.commitChanges;
      return () => {};
    }),
    commitPull: (options: any) => commitPull!(options),
  };
  return adapter;
}

function client(dbAdapter: unknown, extra: Record<string, unknown> = {}) {
  return new SyncClientImpl(clientConfig(dbAdapter, extra), new ChangeBus<any>() as never);
}

/** Tabs whose adapters share one database (rows + outbox), as the leader worker provides. */
function tabs() {
  installTabs();
  const rows = createEngine();
  const store = atomicMemoryStore();
  const group = storageGroup();
  return { rows, store, group, adapter: () => makeDb(rows, store, group.join()) };
}

test("factory creates a client, subscribe overloads filter streams, and live queries rerun on changes", async () => {
  const db = makeDb();
  const syncClient = createSyncClient(clientConfig(db) as never);
  const all = vi.fn();
  const remote = vi.fn();
  const single = vi.fn();
  const several = vi.fn();
  const stopAll = syncClient.subscribe(all);
  syncClient.subscribe(remote, { stream: "remote" });
  syncClient.subscribe("todos" as never, single as never);
  syncClient.subscribe(["todos"] as never, several as never, { stream: "local" });
  const data = vi.fn();
  const query = vi.fn(async () => ["todos"]);
  syncClient.liveQuery({ query, onData: data } as never);
  await tick();
  await syncClient.collections.todos.insert({ id: "1" } as never);
  await tick();
  expect(data).toHaveBeenCalledTimes(2);
  expect(query).toHaveBeenCalledWith(db.queryBuilder, db.querySchema);
  expect(all).toHaveBeenCalledTimes(1);
  expect(single).toHaveBeenCalledTimes(1);
  expect(several).toHaveBeenCalledTimes(1);
  expect(remote).not.toHaveBeenCalled();
  (syncClient as any).changeBus.publishRemote({ type: "delete", collection: "todos", id: "1" });
  await tick();
  expect(remote).toHaveBeenCalledOnce();
  stopAll();
  await syncClient.dispose();
});

test("status and role observers are isolated and receive the current state", async () => {
  vi.stubGlobal("navigator", undefined);
  vi.stubGlobal("addEventListener", undefined);
  vi.stubGlobal("removeEventListener", undefined);
  const good = vi.fn();
  const statuses = vi.fn(() => {
    throw new Error("observer failed");
  });
  const syncClient = client(makeDb(), { onSyncStatus: statuses });
  const unsubscribe = syncClient.subscribeStatus(() => {
    throw new Error("listener failed");
  });
  syncClient.subscribeStatus(good);
  const roles = vi.fn();
  syncClient.subscribeRole(() => {
    throw new Error("role listener failed");
  });
  const unsubscribeRole = syncClient.subscribeRole(roles);
  syncClient.startSync();
  await tick();
  syncClient.startSync();
  expect(statuses).toHaveBeenCalled();
  expect(good.mock.calls.map(([event]) => event.status)).toContain("syncing");
  expect(roles.mock.calls.map(([role]) => role)).toEqual(["follower", "leader"]);
  unsubscribe();
  unsubscribeRole();
  await syncClient.dispose();
});

test("sync client maps handler success and failures into public status callbacks", async () => {
  const db = makeDb();
  const adapter = recordingAdapter();
  const syncClient = client(db, {
    collections: [{ ...collection, syncAdapter: adapter }],
  });
  const statuses: string[] = [];
  syncClient.subscribeStatus((event) => statuses.push(event.status));
  syncClient.startSync();
  await settle();
  adapter.commitPull({ changes: [], checkpoint: {} });
  await tick();
  expect(statuses).toContain("syncing");
  db.transaction.mockRejectedValueOnce(new Error("commit failed"));
  adapter.commitPull({
    changes: [{ type: "create", collection: "todos", data: { id: 1 } }],
    checkpoint: {},
  });
  await settle();
  expect(statuses).toContain("error");
  await syncClient.dispose();
});

test("going offline pauses sync without giving up leadership", async () => {
  const listeners = new Map<string, () => void>();
  vi.stubGlobal("addEventListener", (type: string, listener: () => void) =>
    listeners.set(type, listener),
  );
  vi.stubGlobal("removeEventListener", (type: string) => listeners.delete(type));
  const leader = client(makeDb(), { syncAdapter: recordingAdapter() });
  const statuses: string[] = [];
  leader.subscribeStatus((event) => statuses.push(event.status));
  leader.startSync();
  await settle();
  expect(statuses.at(-1)).toBe("syncing");

  listeners.get("offline")!();
  expect(statuses.at(-1)).toBe("offline");
  listeners.get("online")!();
  expect(statuses.at(-1)).toBe("syncing");
  expect(leader.role).toBe("leader");

  leader.stopSync();
  listeners.get("online")?.();
  expect(statuses.at(-1)).toBe("stopped");
  await leader.dispose();
});

test("only the leader syncs; follower writes reach its push and pulls reach followers", async () => {
  const fixture = tabs();
  const leaderAdapter = recordingAdapter();
  const followerAdapter = recordingAdapter();
  const leader = client(fixture.adapter(), { syncAdapter: leaderAdapter });
  const follower = client(fixture.adapter(), { syncAdapter: followerAdapter });
  const followerStatuses: string[] = [];
  follower.subscribeStatus((event) => followerStatuses.push(event.status));
  await settle();
  expect([leader.role, follower.role]).toEqual(["leader", "follower"]);

  // The follower asks; the leader starts syncing although it never called startSync.
  follower.startSync();
  await settle();
  expect(followerStatuses.at(-1)).toBe("idle");
  expect(leaderAdapter.pull).toHaveBeenCalled();
  expect(followerAdapter.pull).not.toHaveBeenCalled();
  expect(FakeBroadcastChannel.messages("sync-request")).toHaveLength(1);

  const leaderRemote = vi.fn();
  leader.subscribe(leaderRemote, { stream: "remote" });
  await follower.collections.todos.insert({ id: "f1" } as never);
  await settle();
  expect(leaderRemote).toHaveBeenCalledOnce();
  expect(leaderAdapter.push).toHaveBeenCalledOnce();
  expect(followerAdapter.push).not.toHaveBeenCalled();
  expect(await fixture.store.getPendingEvents()).toEqual([]);

  const followerData = vi.fn();
  follower.liveQuery({ collections: ["todos"], query: async () => "rows", onData: followerData });
  await tick();
  followerData.mockClear();
  leaderAdapter.commitPull({
    changes: [{ type: "create", collection: "todos", data: { id: "remote" } }],
    checkpoint: {},
  });
  await settle();
  expect(followerData).toHaveBeenCalled();
  expect(fixture.rows.has("remote")).toBe(true);
  expect(FakeBroadcastChannel.messages("changes").map((m) => m.source)).toEqual(["local", "pull"]);

  await Promise.all([leader.dispose(), follower.dispose()]);
});

test("a promoted follower resumes sync, pushes the outbox and re-reads live queries", async () => {
  const fixture = tabs();
  const leader = client(fixture.adapter());
  const followerAdapter = recordingAdapter();
  const follower = client(fixture.adapter(), { syncAdapter: followerAdapter });
  const third = client(fixture.adapter());
  follower.startSync();
  third.startSync();
  await settle();
  await follower.collections.todos.insert({ id: "before" } as never);
  const roles: string[] = [];
  follower.subscribeRole((role) => roles.push(role));
  const data = vi.fn();
  third.liveQuery({ query: async () => "rows", onData: data });
  await tick();
  data.mockClear();
  FakeBroadcastChannel.posted = [];

  await leader.dispose();
  await settle();
  expect(roles).toEqual(["follower", "leader"]);
  expect(followerAdapter.pull).toHaveBeenCalled();
  // The outbox survived the handoff and the new leader pushed it.
  expect(followerAdapter.push).toHaveBeenCalledOnce();
  expect(data).toHaveBeenCalled();
  // The remaining follower reminds the new leader that it wants sync.
  expect(FakeBroadcastChannel.messages("sync-request")).toHaveLength(1);

  // Repeated role notifications change nothing; demotion stops sync on the old leader.
  (follower as any).dbStorage.setRole("leader");
  expect(roles).toEqual(["follower", "leader"]);
  (follower as any).dbStorage.setRole("follower");
  expect(follower.role).toBe("follower");
  expect((follower as any).syncHandler).toBeUndefined();
  await Promise.all([follower.dispose(), third.dispose()]);
});

test("a gap in another tab's change sequence re-reads live queries", async () => {
  const fixture = tabs();
  const syncClient = client(fixture.adapter());
  const data = vi.fn();
  syncClient.liveQuery({ query: async () => "rows", onData: data });
  await tick();
  const other = new FakeBroadcastChannel(syncChannelName("default"));
  const changes = (seq: number) => ({
    t: "changes",
    sender: "other",
    seq,
    source: "local",
    events: [{ type: "delete", collection: "todos", id: seq }],
  });
  other.postMessage(changes(1));
  other.postMessage(changes(2));
  await tick();
  data.mockClear();
  other.postMessage(changes(5));
  await tick();
  // Once for the gap, once for the delivered event.
  expect(data).toHaveBeenCalledTimes(2);
  other.postMessage({ t: "unknown" });
  await tick();
  // Nothing to announce: nothing is posted.
  const posted = FakeBroadcastChannel.posted.length;
  (syncClient as any).tabs.broadcastChanges([], "pull");
  expect(FakeBroadcastChannel.posted).toHaveLength(posted);
  await syncClient.dispose();
});

test("sync clients without BroadcastChannel stay single-context", async () => {
  installTabs({ channels: false });
  const syncClient = createSyncClient(clientConfig(makeDb(), { collections: [collection] }));
  await settle();
  await syncClient.collections.todos.insert({ id: "1" } as never);
  syncClient.startSync();
  await syncClient.dispose();
});
