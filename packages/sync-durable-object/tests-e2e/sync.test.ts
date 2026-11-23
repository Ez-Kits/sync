import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { device, httpPush, serverChanges, uniqueUser, type Mode } from "./helpers.ts";
import { token } from "./worker.ts";

const WAIT = { timeout: 10_000, interval: 20 };
const devices: ReturnType<typeof device>[] = [];

function start(options: Parameters<typeof device>[0]) {
  const d = device(options);
  devices.push(d);
  d.client.startSync();
  return d;
}

afterEach(async () => {
  for (const d of devices.splice(0)) await d.client.dispose({ ifPendingWrites: "discard" });
});

const revision = (d: ReturnType<typeof device>, collection: string, recordId: string) =>
  d.db.localChangeStore.getRevision({ collection, recordId }) as Promise<number | undefined>;

const caughtUp = (d: ReturnType<typeof device>) => d.caughtUp();
const ids = (changes: { id: string }[]) => changes.map(({ id }) => id).sort();

describe("two clients", () => {
  test("a write on A reaches B live, as changes and through a poke, and echoes on A", async () => {
    const user = uniqueUser();
    // The object with small messages, so a few long rows commit as a `poke`.
    const url = "http://e2e.test/poke/sync";
    const a = start({ user, url });
    const b = start({ user, url });
    await Promise.all([caughtUp(a), caughtUp(b)]);

    await a.client.collections.todos.insert({ id: "t1", title: "first" });
    await vi.waitFor(
      () => expect(b.rows("todos")).toEqual({ t1: { id: "t1", title: "first", done: 0 } }),
      WAIT,
    );
    expect(await revision(b, "todos", "t1")).toBe(1);
    expect(await revision(a, "todos", "t1")).toBe(1);
    // A's own write comes back to it as a live change.
    expect(a.sockets.received).toContainEqual(
      expect.objectContaining({
        type: "changes",
        changes: [expect.objectContaining({ id: "t1", rev: 1 })],
      }),
    );

    // Long rows, so updating all three at once commits more than `maxMessageBytes`.
    const long = "x".repeat(1_500);
    for (const id of ["l1", "l2", "l3"]) {
      await a.client.collections.todos.insert({ id, title: long });
      await a.client.waitForPushed();
    }
    await vi.waitFor(() => expect(Object.keys(b.rows("todos"))).toHaveLength(4), WAIT);
    a.client.stopSync();
    for (const id of ["l1", "l2", "l3"]) await a.client.collections.todos.update({ id, done: 1 });
    a.client.startSync();

    await vi.waitFor(() => {
      for (const id of ["l1", "l2", "l3"]) expect(b.rows("todos")[id]).toMatchObject({ done: 1 });
    }, WAIT);
    expect(b.sockets.received.some((m) => m.type === "poke")).toBe(true);
    expect(await revision(b, "todos", "l1")).toBe(2);
    expect(await revision(a, "todos", "l1")).toBe(2);
  });
});

describe.each<Mode>(["socket", "http"])("over %s", (mode) => {
  test("offline writes are pushed once on reconnect, and resending their events is idempotent", async () => {
    const user = uniqueUser();
    const a = device({ user, mode });
    devices.push(a);
    await a.client.collections.todos.insert({ id: "o1", title: "one" });
    await a.client.collections.todos.insert({ id: "o2", title: "two" });
    await a.client.collections.todos.update({ id: "o1", done: 1 });
    a.client.startSync();
    await a.client.waitForPushed();

    const changes = await serverChanges(user);
    expect(changes.map(({ id, rev }) => ({ id, rev }))).toEqual([
      { id: "o2", rev: 1 },
      { id: "o1", rev: 2 },
    ]);
    expect(changes.find((change) => change.id === "o1")!.data).toEqual({
      id: "o1",
      title: "one",
      done: 1,
    });

    const pushed = a.sockets.pushes.flatMap((push) => push.events);
    expect(pushed).toHaveLength(3);
    // Sent again by the same device, as after a lost reply: answered with the stored revs.
    const reply = await httpPush(user, pushed, a.sockets.pushes[0]!.clientId);
    const stored = new Map(changes.map(({ id, rev }) => [id, rev]));
    expect(reply).toEqual({
      ok: true,
      applied: pushed.map(({ eventId, id }: { eventId: string; id: string }) => ({
        eventId,
        rev: stored.get(id),
      })),
    });
    expect(await serverChanges(user)).toEqual(changes);
    // From another device, the same events are stale writes.
    expect(await httpPush(user, pushed, "another-device")).toMatchObject({ reason: "conflict" });
  });

  test("a conflict goes through core's conflict path, and the local write is replayed over it", async () => {
    const user = uniqueUser();
    const a = start({ user, mode });
    const resolveConflict = vi.fn(() => "local" as const);
    const b = start({ user, mode, extra: { resolveConflict } });
    await a.client.collections.todos.insert({ id: "c", title: "base" });
    await vi.waitFor(() => expect(b.rows("todos").c).toBeDefined(), WAIT);

    a.client.stopSync();
    b.client.stopSync();
    await a.client.collections.todos.update({ id: "c", title: "from a" });
    await b.client.collections.todos.update({ id: "c", done: 1 });
    a.client.startSync();
    await a.client.waitForPushed();
    b.client.startSync();
    await b.client.waitForPushed();

    expect(b.sockets.pushes.map((push) => push.reply.reason ?? "ok")).toEqual(["conflict", "ok"]);
    expect(resolveConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        remote: expect.objectContaining({
          rev: 2,
          data: expect.objectContaining({ title: "from a" }),
        }),
      }),
    );
    const expected = { id: "c", title: "from a", done: 1 };
    await vi.waitFor(() => {
      expect(a.rows("todos").c).toEqual(expected);
      expect(b.rows("todos").c).toEqual(expected);
    }, WAIT);
    expect((await serverChanges(user))[0]).toMatchObject({ id: "c", rev: 3, data: expected });
  });

  test("a rejection by validate parks that write, and the rest of the batch applies", async () => {
    const user = uniqueUser();
    const onPushRejected = vi.fn();
    const a = device({ user, mode, extra: { onPushRejected } });
    devices.push(a);
    for (const [id, title] of [
      ["r1", "ok"],
      ["r2", "bad"],
      ["r3", "ok"],
    ]) {
      await a.client.collections.todos.insert({ id, title });
    }
    a.client.startSync();

    await vi.waitFor(() => expect(onPushRejected).toHaveBeenCalledTimes(1), WAIT);
    expect(onPushRejected.mock.calls[0]![0].event.data).toEqual({ id: "r2", title: "bad" });
    expect(onPushRejected.mock.calls[0]![0].error).toMatchObject({ code: "invalid-argument" });
    await vi.waitFor(async () => {
      expect(ids(await serverChanges(user))).toEqual(["r1", "r3"]);
    }, WAIT);
    // The first push carried all three and was refused whole; core split it.
    // Over the socket, the first push may still go over HTTP, before the socket opens.
    if (mode === "http") expect(a.sockets.pushes.every((push) => push.via === "http")).toBe(true);
    const pushes = a.sockets.pushes.map((push) => [
      push.events.map((event: { id: string }) => event.id),
      push.reply.reason ?? "ok",
    ]);
    expect(pushes).toEqual([
      [["r1", "r2", "r3"], "rejected"],
      [["r1", "r2"], "rejected"],
      [["r1"], "ok"],
      [["r2"], "rejected"],
      [["r3"], "ok"],
    ]);
  });

  test("a pull pages with hasMore, catches up, and a restarted client resumes from its checkpoints", async () => {
    const user = uniqueUser();
    const rows = Array.from({ length: 1_100 }, (_, i) => ({
      collection: "todos",
      id: `p${i}`,
      data: { id: `p${i}`, title: `row ${i}` },
      rev: 1,
    }));
    await runInDurableObject(env.E2E_SYNC.getByName(user), (instance) => instance.importRows(rows));

    const a = start({ user, mode });
    await caughtUp(a);
    await vi.waitFor(() => expect(Object.keys(a.rows("todos"))).toHaveLength(1_100), WAIT);
    const pages = a.sockets.pages.map((m) => [m.changes.length, m.hasMore]);
    // Polling keeps pulling empty pages after the three.
    expect(pages.slice(0, 3)).toEqual([
      [500, true],
      [500, true],
      [100, false],
    ]);
    expect(pages.slice(3).every(([length]) => length === 0)).toBe(true);
    if (mode === "socket") expect(a.sockets.received.at(-1)).toEqual({ type: "caught-up" });
    await vi.waitFor(async () => expect(await a.client.getCheckpoint("todos")).toBe(1_100), WAIT);

    await a.client.dispose();
    devices.splice(devices.indexOf(a), 1);
    const restarted = start({ user, mode, db: a.db });
    await caughtUp(restarted);
    expect(restarted.sockets.pulls[0]).toMatchObject({ todos: 1_100 });
    expect(restarted.sockets.pages[0]).toMatchObject({ changes: [], hasMore: false });
    expect(restarted.sockets.pages.every((page) => page.changes.length === 0)).toBe(true);
  });

  test("delete tombstones reach the other client for text, number and composite keys", async () => {
    const user = uniqueUser();
    const a = start({ user, mode });
    const b = start({ user, mode });
    await Promise.all([caughtUp(a), caughtUp(b)]);
    await a.client.collections.todos.insert({ id: "d", title: "gone soon" });
    await a.client.collections.notes.insert({ id: 5, body: "five" });
    await a.client.collections.pairs.insert({ a: "x", b: 2, label: "pair" });
    await vi.waitFor(() => {
      expect(b.rows("notes")).toEqual({ "5": { id: 5, body: "five" } });
      expect(b.rows("pairs")).toEqual({ '["x",2]': { a: "x", b: 2, label: "pair" } });
    }, WAIT);

    await a.client.collections.todos.delete("d");
    await a.client.collections.notes.delete(5);
    await a.client.collections.pairs.delete({ a: "x", b: 2 });
    await vi.waitFor(() => {
      expect(b.rows("todos")).toEqual({});
      expect(b.rows("notes")).toEqual({});
      expect(b.rows("pairs")).toEqual({});
    }, WAIT);
    const deletes = b.db.delete.mock.calls.map((call: unknown[]) => call.slice(0, 2));
    expect(deletes).toContainEqual(["notes", 5]);
    expect(deletes).toContainEqual(["pairs", { a: "x", b: 2 }]);
    expect(await revision(b, "notes", "5")).toBe(2);
    expect((await serverChanges(user)).filter((change) => change.deleted)).toHaveLength(3);
  });

  test("a batch of 500 with one rejected is halved down to it, and the other 499 apply", async () => {
    const user = uniqueUser();
    const onPushRejected = vi.fn();
    const a = device({ user, mode, extra: { onPushRejected } });
    devices.push(a);
    const all = Array.from({ length: 500 }, (_, i) => `b${String(i).padStart(3, "0")}`);
    for (const [i, id] of all.entries()) {
      await a.client.collections.todos.insert({ id, title: i === 321 ? "bad" : "ok" });
    }
    a.client.startSync();

    await vi.waitFor(() => expect(onPushRejected).toHaveBeenCalledTimes(1), WAIT);
    expect(onPushRejected.mock.calls[0]![0].event.data).toEqual({ id: "b321", title: "bad" });
    expect(onPushRejected.mock.calls[0]![0].error.name).toBe("PushRejectedError");
    await vi.waitFor(async () => {
      expect(ids(await serverChanges(user))).toEqual(all.filter((id) => id !== "b321"));
    }, WAIT);
    const { pushes } = a.sockets;
    expect(pushes[0]!.events).toHaveLength(500);
    expect(pushes[0]!.reply).toMatchObject({ reason: "rejected", index: 321 });
    // Each accepted event went out in exactly one accepted push.
    const accepted = pushes.filter((push) => push.reply.ok).flatMap((push) => push.events);
    expect(ids(accepted)).toEqual(all.filter((id) => id !== "b321"));
    expect(pushes.length).toBeLessThan(2 * Math.log2(500) + 2);
  });

  test("a parent delete cascades: the other client gets its children's tombstones, a new one pulls cleanly", async () => {
    const user = uniqueUser();
    const a = start({ user, mode });
    const b = start({ user, mode });
    await Promise.all([caughtUp(a), caughtUp(b)]);
    await a.client.collections.groups.insert({ id: "g1", name: "one" });
    await a.client.collections.groups.insert({ id: "g2", name: "two" });
    for (const [id, groupId] of [
      ["m1", "g1"],
      ["m2", "g1"],
      ["m3", "g2"],
    ]) {
      await a.client.collections.members.insert({ id, groupId, name: id });
    }
    await vi.waitFor(() => expect(Object.keys(b.rows("members"))).toHaveLength(3), WAIT);

    await a.client.collections.groups.delete("g1");
    const remaining = { m3: { id: "m3", groupId: "g2", name: "m3" } };
    await vi.waitFor(() => {
      expect(b.rows("groups")).toEqual({ g2: { id: "g2", name: "two" } });
      expect(b.rows("members")).toEqual(remaining);
      // A deleted only the parent; its children's tombstones come back to it too.
      expect(a.rows("members")).toEqual(remaining);
    }, WAIT);
    expect(await revision(b, "members", "m1")).toBe(2);

    const c = start({ user, mode });
    await caughtUp(c);
    expect(c.rows("groups")).toEqual({ g2: { id: "g2", name: "two" } });
    expect(c.rows("members")).toEqual(remaining);
    expect(c.onSyncStatus.mock.calls.flat()).not.toContainEqual(
      expect.objectContaining({ error: expect.anything() }),
    );
  });
});

describe("tokens", () => {
  /** Expire the token of every open socket of `user`'s object now, without waiting for the clock. */
  const expireSockets = (user: string) =>
    runInDurableObject(env.E2E_SYNC.getByName(user), (_instance, state) => {
      for (const ws of state.getWebSockets()) {
        ws.serializeAttachment({ ...ws.deserializeAttachment(), expiresAt: 0 });
      }
    });

  // A wider timeout only as margin: each test waits on events, plus core's first retries.
  test("an expired token is refreshed with an auth message on the open socket", async () => {
    const user = uniqueUser();
    const a = start({ user });
    await caughtUp(a);
    await expireSockets(user);

    // The push is answered `unauthenticated`; the client sends `auth` and core retries it.
    await a.client.collections.todos.insert({ id: "fresh", title: "after expiry" });
    await a.client.waitForPushed({ timeoutMs: 10_000 });
    expect(a.sockets.received).toContainEqual({ type: "unauthenticated" });
    expect(a.sockets.sent).toContainEqual({ type: "auth", token: a.auth.token });
    expect(a.sockets.opened).toBe(1);
    expect(a.sockets.closes).toEqual([]);
    expect((await serverChanges(user)).map(({ id }) => id)).toEqual(["fresh"]);
  }, 15_000);

  test("a pull that arrives after the token expired is sent again after the refresh", async () => {
    const user = uniqueUser();
    await httpPush(user, [
      {
        eventId: "s",
        collection: "todos",
        type: "create",
        id: "s",
        data: { title: "seed" },
        rev: 1,
      },
    ]);
    // The first pull reaches the object with the socket's token already expired.
    const a = start({ user, beforeOpen: () => expireSockets(user) });
    await caughtUp(a);
    expect(a.sockets.received).toContainEqual({ type: "unauthenticated" });
    expect(a.sockets.sent.filter((message) => message.type === "pull")).toHaveLength(2);
    expect(a.sockets.opened).toBe(1);
    expect(a.sockets.closes).toEqual([]);
    expect(a.rows("todos").s).toMatchObject({ title: "seed" });
  }, 15_000);

  test("an invalid refresh closes the socket with 4001, and a valid token recovers", async () => {
    const user = uniqueUser();
    const a = start({ user });
    await caughtUp(a);
    // Tokens are invalid until the socket closes with 4001, then valid again.
    a.getToken.mockImplementation(() =>
      a.sockets.closes.includes(4001) ? token(user) : `${user}:0`,
    );
    await expireSockets(user);

    await a.client.collections.todos.insert({ id: "late", title: "pushed after recovery" });
    await a.client.waitForPushed({ timeoutMs: 10_000 });
    expect(a.sockets.sent).toContainEqual({ type: "auth", token: `${user}:0` });
    expect(a.sockets.closes).toContain(4001);
    expect((await serverChanges(user)).map(({ id }) => id)).toEqual(["late"]);
  }, 15_000);
});

test("a socket client and a polling client sync with each other", async () => {
  const user = uniqueUser();
  const a = start({ user, mode: "http" });
  const b = start({ user });
  await a.client.collections.todos.insert({ id: "h", title: "over http" });
  await a.client.waitForPushed();
  expect(a.sockets.pushes.map((push) => [push.via, push.reply.ok])).toEqual([["http", true]]);
  await vi.waitFor(
    () => expect(b.rows("todos").h).toEqual({ id: "h", title: "over http", done: 0 }),
    WAIT,
  );

  await b.client.collections.todos.update({ id: "h", done: 1 });
  await b.client.waitForPushed();
  await vi.waitFor(() => expect(a.rows("todos").h).toMatchObject({ done: 1 }), WAIT);
  expect(await revision(a, "todos", "h")).toBe(2);
});

test("an eviction between the commit and the reply: the retried push applies once", async () => {
  const user = uniqueUser();
  const a = start({ user });
  await caughtUp(a);
  await a.client.collections.todos.insert({ id: "e", title: "evict" });
  await a.client.waitForPushed({ timeoutMs: 10_000 });

  // The first attempt committed, then the object reset before answering.
  expect(
    a.sockets.closes.length + a.sockets.pushes.filter((p) => !p.reply?.ok).length,
  ).toBeGreaterThan(0);
  const changes = await serverChanges(user);
  expect(changes.map(({ id, rev }) => ({ id, rev }))).toEqual([{ id: "e", rev: 1 }]);
  // The retry was recognized as this device's own write.
  const record = await runInDurableObject(env.E2E_SYNC.getByName(user), (_instance, state) =>
    state.storage.sql.exec("SELECT rev, client_id FROM ez_sync_records WHERE id = 'e'").one(),
  );
  const clientIds = new Set(a.sockets.pushes.map((push) => push.clientId));
  expect(clientIds.size).toBe(1);
  expect(record).toEqual({ rev: 1, client_id: [...clientIds][0] });
});

test("a parked write that is retried later lands with the write held behind it", async () => {
  const user = uniqueUser();
  const onPushRejected = vi.fn();
  const a = start({ user, extra: { onPushRejected } });
  await caughtUp(a);
  await a.client.collections.todos.insert({ id: "p", title: "bad" });
  await a.client.collections.todos.update({ id: "p", done: 1 });
  await a.client.collections.todos.insert({ id: "q", title: "ok" });
  await vi.waitFor(() => expect(onPushRejected).toHaveBeenCalledOnce(), WAIT);
  // `q` went past the parked record; `p`'s update waits behind its create.
  await vi.waitFor(async () => expect(ids(await serverChanges(user))).toEqual(["q"]), WAIT);

  await runInDurableObject(env.E2E_SYNC.getByName(user), (instance) => {
    instance.refused.clear();
  });
  // Starting sync retries parked writes.
  a.client.stopSync();
  a.client.startSync();
  await a.client.waitForPushed({ timeoutMs: 10_000 });
  const p = (await serverChanges(user)).find((change) => change.id === "p");
  expect(p).toMatchObject({ rev: 2, data: { id: "p", title: "bad", done: 1 } });
});

test("a discarded parked write releases the write held behind it, which applies", async () => {
  const user = uniqueUser();
  const onPushRejected = vi.fn();
  const a = start({ user, extra: { onPushRejected } });
  await caughtUp(a);
  await a.client.collections.todos.insert({ id: "d", title: "bad" });
  await a.client.collections.todos.update({ id: "d", title: "fixed" });
  await a.client.collections.todos.insert({ id: "q", title: "ok" });
  await vi.waitFor(() => expect(onPushRejected).toHaveBeenCalledOnce(), WAIT);
  await vi.waitFor(async () => expect(ids(await serverChanges(user))).toEqual(["q"]), WAIT);

  await onPushRejected.mock.calls[0]![0].discard();
  await a.client.waitForPushed({ timeoutMs: 10_000 });
  const d = (await serverChanges(user)).find((change) => change.id === "d");
  expect(d).toMatchObject({ rev: 1, data: { id: "d", title: "fixed" } });
});

test("the clientId lives with the database: a reload and the next tab reuse it, a wipe makes a new one", async () => {
  const user = uniqueUser();
  const clientIdOf = (d: ReturnType<typeof device>) => {
    const sent = new Set(d.sockets.pushes.map((push) => push.clientId));
    expect(sent.size).toBe(1);
    return [...sent][0]!;
  };
  const a = start({ user });
  await a.client.collections.todos.insert({ id: "t1", title: "one" });
  await a.client.waitForPushed({ timeoutMs: 10_000 });
  const first = clientIdOf(a);
  expect(first).toMatch(/^[0-9a-f-]{36}$/);

  // Another tab on the same database takes over pushing.
  a.client.stopSync();
  const tab = start({ user, db: a.db });
  await tab.client.collections.todos.insert({ id: "t2", title: "two" });
  await tab.client.waitForPushed({ timeoutMs: 10_000 });
  expect(clientIdOf(tab)).toBe(first);
  tab.client.stopSync();

  // A reload: a new store object over the same stored outbox and checkpoints.
  const reloaded = start({ user, store: { ...a.db.localChangeStore } });
  await reloaded.client.collections.todos.insert({ id: "t3", title: "three" });
  await reloaded.client.waitForPushed({ timeoutMs: 10_000 });
  expect(clientIdOf(reloaded)).toBe(first);

  // Wiped storage: a new device id.
  const wiped = start({ user });
  await wiped.client.collections.todos.insert({ id: "t4", title: "four" });
  await wiped.client.waitForPushed({ timeoutMs: 10_000 });
  expect(clientIdOf(wiped)).not.toBe(first);
  expect(ids(await serverChanges(user))).toEqual(["t1", "t2", "t3", "t4"]);
});
