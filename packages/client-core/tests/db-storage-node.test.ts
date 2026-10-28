import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  CoordinationUnavailableError,
  DBStorageClosedError,
  LeaderChangedError,
  LeaderUnavailableError,
  TransactionStatementError,
} from "../src/db-storage";
import { leaderChannelName } from "../src/db-storage/protocol";
import type { DBEngine } from "../src/db-storage";
import { createDisk, memoryEngine, q, startNode } from "./helpers/db-storage";
import { settle, tick } from "./helpers/storage";
import { FakeBroadcastChannel, installTabs } from "./helpers/tabs";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const exec = (node: { request(body: unknown): Promise<unknown> }, sql: string, txId?: string) =>
  node.request({ t: "exec", query: q(sql, sql === "GET" ? "all" : "run"), txId }) as Promise<{
    rows: unknown[];
  }>;
const begin = (node: { request(body: unknown): Promise<unknown> }) =>
  node.request({ t: "begin" }) as Promise<string>;

test("the first context leads and opens the engine; others forward reads and writes", async () => {
  const { locks } = installTabs();
  const disk = createDisk();
  const leader = startNode(locks, "a", { disk });
  await settle();
  const follower = startNode(locks, "b", { disk });
  const late = startNode(locks, "c", { disk });
  await settle();
  expect([leader.role, follower.role, late.role]).toEqual(["leader", "follower", "follower"]);
  // Already queued for leadership: rejoining changes nothing.
  follower.node.rejoin();
  expect(leader.engines).toHaveLength(1);
  expect(follower.engines).toHaveLength(0);

  await exec(follower.node, "SET b 1");
  await exec(leader.node, "SET a 1");
  expect((await exec(late.node, "GET")).rows).toEqual([
    ["b", "1"],
    ["a", "1"],
  ]);
  await expect(exec(follower.node, "BEGIN")).rejects.toBeInstanceOf(TransactionStatementError);
  // Followers never announce themselves as leaders.
  expect(FakeBroadcastChannel.messages("leader-hello").length).toBeGreaterThan(0);
  await Promise.all([leader.node.close(), follower.node.close(), late.node.close()]);
});

test("forwarded transactions are isolated and serialized on the leader", async () => {
  const { locks } = installTabs();
  const disk = createDisk();
  const leader = startNode(locks, "a", { disk });
  await settle();
  const b = startNode(locks, "b", { disk });
  const c = startNode(locks, "c", { disk });
  await settle();

  const txB = await begin(b.node);
  await exec(b.node, "SET b1 1", txB);
  const txC = begin(c.node);
  const outside = exec(leader.node, "SET outside 1");
  await settle();
  await exec(b.node, "SET b2 1", txB);
  await b.node.request({ t: "commit", txId: txB });
  const cId = await txC;
  await exec(c.node, "SET c1 1", cId);
  await c.node.request({ t: "rollback", txId: cId });
  await outside;
  expect(leader.engines[0]!.log).toEqual([
    "BEGIN",
    "SET b1 1",
    "SET b2 1",
    "COMMIT",
    // Queued locally before the second follower's BEGIN reached the leader.
    "SET outside 1",
    "BEGIN",
    "SET c1 1",
    "ROLLBACK",
  ]);
  expect([...disk.rows.keys()]).toEqual(["b1", "b2", "outside"]);

  // The leader runs its own transactions in place.
  const own = await begin(leader.node);
  await exec(leader.node, "SET own 1", own);
  await leader.node.request({ t: "commit", txId: own });
  expect(disk.rows.has("own")).toBe(true);
  await Promise.all([leader.node.close(), b.node.close(), c.node.close()]);
});

test("the leader rolls back the transaction of a context that died", async () => {
  const { locks } = installTabs();
  const disk = createDisk();
  const leader = startNode(locks, "a", { disk });
  await settle();
  const follower = startNode(locks, "b", { disk });
  await settle();
  const tx = await begin(follower.node);
  await exec(follower.node, "SET lost 1", tx);
  const waiting = exec(leader.node, "SET after 1");
  follower.crash();
  await waiting;
  expect([...disk.rows.keys()]).toEqual(["after"]);
  expect(leader.engines[0]!.log).toContain("ROLLBACK");

  // A transaction that finished normally stops watching its owner.
  const other = startNode(locks, "c", { disk });
  await settle();
  const ok = await begin(other.node);
  await other.node.request({ t: "commit", txId: ok });
  const retried = await begin(other.node);
  await other.node.request({ t: "rollback", txId: retried });
  await Promise.all([leader.node.close(), other.node.close()]);
});

test("on leader change, reads are re-sent while writes and transactions fail retriably", async () => {
  const { locks } = installTabs();
  const disk = createDisk();
  const leader = startNode(locks, "a", { disk });
  await settle();
  const follower = startNode(locks, "b", { disk });
  const third = startNode(locks, "c", { disk });
  await settle();
  await exec(follower.node, "SET kept 1");
  const tx = await begin(third.node);

  // Sent to the leader after it died: never answered.
  leader.crash();
  const read = exec(follower.node, "GET");
  const write = exec(follower.node, "SET lost 1");
  // The dead leader may or may not have applied it: only the caller can decide to retry.
  const writeFailed = expect(write).rejects.toBeInstanceOf(LeaderChangedError);
  // Another follower learns about the new leader from its announcement.
  const thirdRead = exec(third.node, "GET");
  const thirdWrite = expect(exec(third.node, "SET lost 2")).rejects.toBeInstanceOf(
    LeaderChangedError,
  );
  await settle(8);
  expect(follower.role).toBe("leader");
  expect(third.role).toBe("follower");
  expect(third.invalidate).toHaveBeenCalled();
  expect((await read).rows).toEqual([["kept", "1"]]);
  await Promise.all([writeFailed, thirdWrite]);
  expect((await thirdRead).rows).toEqual([["kept", "1"]]);
  // The old leader's transaction is gone.
  await expect(exec(third.node, "SET x 1", tx)).rejects.toBeInstanceOf(LeaderChangedError);
  await expect(third.node.request({ t: "commit", txId: tx })).rejects.toBeInstanceOf(
    LeaderChangedError,
  );
  await expect(exec(follower.node, "SET y 1", tx)).rejects.toBeInstanceOf(LeaderChangedError);
  await Promise.all([follower.node.close(), third.node.close()]);
});

test("requests in flight to a departing leader: reads wait for the next one, writes fail", async () => {
  const { locks } = installTabs();
  const disk = createDisk();
  const leader = startNode(locks, "a", { disk });
  await settle();
  const follower = startNode(locks, "b", { disk });
  await settle();
  const tx = await begin(follower.node);
  // Keep the leader in its closing phase for a while.
  leader.engines[0]!.flush.mockImplementation(
    () => new Promise((resolve) => setTimeout(resolve, 20)),
  );

  // The leader receives requests but handles them only while stepping down.
  const requests = FakeBroadcastChannel.instances.find(
    (channel) => channel.tag === "a" && channel.name.includes(":leader:"),
  )!;
  const handle = requests.onmessage!;
  const held: MessageEvent[] = [];
  requests.onmessage = (event) => held.push(event);
  // Replies may overtake the goodbye: drop it so only the replies reroute requests.
  const control = FakeBroadcastChannel.instances.find(
    (channel) => channel.tag === "b" && channel.name === "ez-sync:db:default",
  )!;
  const onControl = control.onmessage!;
  control.onmessage = (event) => {
    if (event.data?.t !== "leader-bye") onControl(event);
  };
  const read = exec(follower.node, "GET");
  const write = expect(exec(follower.node, "SET lost 1")).rejects.toBeInstanceOf(
    LeaderChangedError,
  );
  const inTx = expect(exec(follower.node, "SET tx 1", tx)).rejects.toBeInstanceOf(
    LeaderChangedError,
  );
  // Queued behind the follower's transaction when leadership ends.
  const own = expect(exec(leader.node, "SET own 1")).rejects.toBeInstanceOf(LeaderChangedError);
  await settle();
  leader.node.release();
  await tick();
  for (const event of held) handle(event);
  await Promise.all([write, inTx, own]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await settle(8);
  expect(follower.role).toBe("leader");
  expect((await read).rows).toEqual([]);
  expect(leader.role).toBe("follower");

  // The old leader rejoins as a follower and is not re-elected while the other leads.
  leader.node.rejoin();
  await settle();
  expect(leader.role).toBe("follower");
  expect(leader.invalidate).toHaveBeenCalled();
  await Promise.all([leader.node.close(), follower.node.close()]);
});

test("an engine still opening when leadership ends is closed once it opens", async () => {
  const { locks } = installTabs();
  let resolveOpen!: (engine: DBEngine) => void;
  const opened = startNode(locks, "a", {
    open: () => new Promise<DBEngine>((resolve) => (resolveOpen = resolve)),
  });
  await settle();
  await opened.node.close();
  const engine = memoryEngine();
  resolveOpen(engine);
  await settle();
  expect(engine.close).toHaveBeenCalledOnce();
  expect(opened.errors).toEqual([]);

  let rejectOpen!: (error: unknown) => void;
  const failed = startNode(locks, "b", {
    open: () => new Promise<DBEngine>((_, reject) => (rejectOpen = reject)),
  });
  await settle();
  await failed.node.close();
  rejectOpen(new Error("too late"));
  await settle();
  expect(failed.errors).toEqual([]);
});

test("a follower promoted with queued requests runs them itself", async () => {
  const { locks } = installTabs();
  const disk = createDisk();
  const leader = startNode(locks, "a", { disk });
  await settle();
  const follower = startNode(locks, "b", { disk });
  await settle();
  const tx = await begin(follower.node);
  // Silence the leader so requests stay unanswered, then hand over leadership.
  for (const channel of FakeBroadcastChannel.instances) {
    if (channel.name === leaderChannelName("default", "x") || channel.tag !== "a") continue;
    if (channel.name.includes(":leader:")) channel.onmessage = null;
  }
  const failingRead = expect(
    follower.node.request({ t: "exec", query: q("BOOM", "all") }),
  ).rejects.toThrow("statement failed");
  const read = exec(follower.node, "GET");
  const write = exec(follower.node, "SET lost 1");
  const inTx = exec(follower.node, "SET tx 1", tx);
  leader.crash();
  await expect(write).rejects.toBeInstanceOf(LeaderChangedError);
  await expect(inTx).rejects.toBeInstanceOf(LeaderChangedError);
  expect((await read).rows).toEqual([]);
  expect(follower.role).toBe("leader");
  expect(follower.invalidate).toHaveBeenCalledOnce();
  await failingRead;
  await follower.node.close();
});

test("requests sent before any leader is known wait for one", async () => {
  const { locks } = installTabs();
  const disk = createDisk();
  let openLeader!: () => void;
  const opening = new Promise<void>((resolve) => (openLeader = resolve));
  const leader = startNode(locks, "a", {
    disk,
    open: async () => {
      await opening;
      const { memoryEngine } = await import("./helpers/db-storage");
      return memoryEngine(disk);
    },
  });
  await settle();
  const follower = startNode(locks, "b", { disk });
  const write = exec(follower.node, "SET early 1");
  await settle();
  openLeader();
  await write;
  expect(disk.rows.has("early")).toBe(true);
  expect(follower.invalidate).not.toHaveBeenCalled();
  await Promise.all([leader.node.close(), follower.node.close()]);
});

test("a busy leader keeps followers waiting; a silent one makes them give up", async () => {
  vi.useFakeTimers();
  const { locks } = installTabs();
  const disk = createDisk();
  startNode(locks, "a", { disk, requestTimeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(0);
  const follower = startNode(locks, "b", { disk, requestTimeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(0);

  const slow = exec(follower.node, "WAIT 250");
  await vi.advanceTimersByTimeAsync(300);
  await slow;
  expect(FakeBroadcastChannel.messages("who-is-leader").length).toBeGreaterThan(2);

  // The leader stops answering anything (frozen tab that kept its lock).
  for (const channel of FakeBroadcastChannel.instances) {
    if (channel.tag === "a") channel.close();
  }
  const stuck = exec(follower.node, "GET");
  const assertion = expect(stuck).rejects.toBeInstanceOf(LeaderUnavailableError);
  await vi.advanceTimersByTimeAsync(250);
  await assertion;
  await follower.node.close();
});

test("a context that cannot open the engine reports it and lets the next one lead", async () => {
  const { locks } = installTabs();
  const disk = createDisk();
  const broken = startNode(locks, "a", {
    disk,
    open: async () => Promise.reject(new Error("quota exceeded")),
  });
  await settle();
  expect(broken.errors).toEqual([new Error("quota exceeded")]);
  const healthy = startNode(locks, "b", { disk });
  await settle();
  expect(healthy.role).toBe("leader");
  await Promise.all([broken.node.close(), healthy.node.close()]);
});

test("election failures and missing Web Locks are reported", async () => {
  const { locks } = installTabs();
  const missing = startNode(locks, "a", { locksAvailable: false });
  expect(missing.errors[0]).toBeInstanceOf(CoordinationUnavailableError);
  await missing.node.close();

  locks.request.mockImplementation(() => Promise.reject(new Error("lock denied")));
  const denied = startNode(locks, "b");
  await settle();
  expect(denied.errors).toEqual([new Error("lock denied")]);
  await denied.node.close();
});

test("closed nodes reject requests and pending ones; release before leading is harmless", async () => {
  const { locks } = installTabs();
  const leader = startNode(locks, "a");
  await settle();
  const follower = startNode(locks, "b");
  await settle();
  for (const channel of FakeBroadcastChannel.instances) {
    if (channel.tag === "a" && channel.name.includes(":leader:")) channel.onmessage = null;
  }
  const pending = exec(follower.node, "GET");
  await follower.node.close();
  await follower.node.close();
  await expect(pending).rejects.toBeInstanceOf(DBStorageClosedError);
  await expect(exec(follower.node, "GET")).rejects.toBeInstanceOf(DBStorageClosedError);
  follower.node.rejoin();
  follower.node.release();

  // Stray, stale or malformed messages are ignored.
  const stray = new FakeBroadcastChannel("ez-sync:db:default");
  stray.postMessage({ t: "unknown" });
  stray.postMessage({ t: "leader-hello", epoch: "stale" });
  stray.postMessage({ t: "leader-bye", epoch: "stale" });
  new FakeBroadcastChannel("ez-sync:db:default:client:a").postMessage({ t: "ok", id: "none" });
  await settle();
  expect(leader.role).toBe("leader");
  await leader.node.close();
  expect(leader.engines[0]!.close).toHaveBeenCalledOnce();
});

test("a leader's goodbye fails its pending writes and keeps reads for the next leader", async () => {
  const { locks } = installTabs();
  const disk = createDisk();
  const leader = startNode(locks, "a", { disk });
  await settle();
  const follower = startNode(locks, "b", { disk });
  await settle();
  for (const channel of FakeBroadcastChannel.instances) {
    if (channel.tag === "a" && channel.name.includes(":leader:")) channel.onmessage = null;
  }
  const read = exec(follower.node, "GET");
  const write = expect(exec(follower.node, "SET lost 1")).rejects.toBeInstanceOf(
    LeaderChangedError,
  );
  await settle();
  leader.node.release();
  await write;
  expect((await read).rows).toEqual([]);
  expect(follower.role).toBe("leader");
  await Promise.all([leader.node.close(), follower.node.close()]);
});

test("a context's statements outside its transaction wait for it to end", async () => {
  const { locks } = installTabs();
  const disk = createDisk();
  const leader = startNode(locks, "a", { disk });
  await settle();
  const follower = startNode(locks, "b", { disk });
  await settle();
  const tx = await begin(follower.node);
  await exec(follower.node, "SET pending 1", tx);
  const followerRead = exec(follower.node, "GET");
  const leaderWrite = exec(leader.node, "SET other 1");
  await settle();
  expect(disk.rows.has("other")).toBe(false);
  await follower.node.request({ t: "rollback", txId: tx });
  expect((await followerRead).rows).not.toContainEqual(["pending", "1"]);
  await leaderWrite;
  expect([...disk.rows.keys()]).toEqual(["other"]);
  await Promise.all([leader.node.close(), follower.node.close()]);
});
