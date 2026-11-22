import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vite-plus/test";
import { CLOSE_UNAUTHENTICATED, SUBPROTOCOL } from "../src/server.ts";
import { httpPush, listEvent, openSocket, pullAll, socketPush, uniqueScope } from "./helpers.ts";
import { token } from "./worker.ts";

const createList = (id: string, name = id) => listEvent({ type: "create", id, data: { name } });

describe("socket", () => {
  test("the 101 sends back the subprotocol without the token", async () => {
    const socket = await openSocket(uniqueScope());
    expect(socket.response.status).toBe(101);
    expect(socket.response.headers.get("Sec-WebSocket-Protocol")).toBe(SUBPROTOCOL);
  });

  test("ping is answered by the auto-response", async () => {
    const socket = await openSocket(uniqueScope());
    const pong = new Promise((resolve) =>
      socket.ws.addEventListener("message", (event) => resolve(event.data)),
    );
    socket.send("ping");
    expect(await pong).toBe("pong");
  });

  test("pulls pages with counts, then goes live and receives later commits", async () => {
    const scope = uniqueScope();
    await httpPush(scope, [createList("l1"), createList("l2"), createList("l3")]);
    await httpPush(scope, [
      listEvent({ type: "create", collection: "items", id: '["l1",1]', data: { title: "t" } }),
    ]);
    const socket = await openSocket(scope);
    const received = await pullAll(socket, {
      type: "pull",
      checkpoints: { lists: null, items: 1, unknown: null },
      limit: 2,
      count: true,
    });
    expect(received.map((message) => message.type)).toEqual([
      "count",
      "count",
      "changes",
      "changes",
      "caught-up",
    ]);
    expect(received.slice(0, 2)).toEqual([
      { type: "count", collection: "lists", total: 3 },
      { type: "count", collection: "items", total: 1 },
    ]);
    expect(received[2]).toMatchObject({
      changes: [
        { id: "l1", seq: 1 },
        { id: "l2", seq: 2 },
      ],
      checkpoints: { lists: 2 },
      hasMore: true,
    });
    expect(received[3]).toMatchObject({
      changes: [
        { id: "l3", seq: 3 },
        { id: '["l1",1]', seq: 4, data: { listId: "l1", position: 1 } },
      ],
      checkpoints: { lists: 3, items: 4 },
      hasMore: false,
    });
    // Live: its own push comes back as `changes` before the reply.
    await socketPush(socket, [
      listEvent({ type: "update", id: "l1", rev: 2, data: { name: "x" } }),
    ]);
    await httpPush(scope, [listEvent({ type: "delete", id: "l2", rev: 2 })]);
    const live = await socket.next();
    expect(live).toEqual({
      type: "changes",
      changes: [{ collection: "lists", id: "l2", seq: 6, rev: 2, deleted: true }],
      checkpoints: { lists: 6 },
      hasMore: false,
    });
  });

  test("a change committed during paging is delivered exactly once", async () => {
    const scope = uniqueScope();
    await httpPush(scope, [createList("l1"), createList("l2")]);
    const socket = await openSocket(scope);
    socket.send({ type: "pull", checkpoints: { lists: null }, limit: 1 });
    expect(await socket.next()).toMatchObject({ changes: [{ id: "l1" }], hasMore: true });
    // Not live yet: this commit reaches the socket through the next pages only.
    await httpPush(scope, [createList("l3")]);
    const rest = await pullAll(socket, { type: "pull", checkpoints: { lists: 1 }, limit: 1 });
    const ids = rest.flatMap((message) =>
      message.type === "changes" ? message.changes.map((c) => c.id) : [],
    );
    expect(ids).toEqual(["l2", "l3"]);
    await httpPush(scope, [createList("l4")]);
    expect(await socket.next()).toMatchObject({ changes: [{ id: "l4" }] });
    expect(socket.unread()).toBe(0);
  });

  test("a hibernated socket receives a live change", async () => {
    const scope = uniqueScope();
    const socket = await openSocket(scope);
    await pullAll(socket, { type: "pull", checkpoints: { lists: null } });
    await evictDurableObject(env.TEST_SYNC.getByName(scope));
    await httpPush(scope, [createList("l1")]);
    expect(await socket.next()).toMatchObject({ type: "changes", changes: [{ id: "l1" }] });
  });

  test("a commit too large for one message sends poke", async () => {
    const scope = uniqueScope();
    const socket = await openSocket(scope);
    await pullAll(socket, { type: "pull", checkpoints: { lists: null } });
    await runInDurableObject(env.TEST_SYNC.getByName(scope), (instance) => {
      instance.maxMessageBytes = 150;
    });
    await httpPush(scope, [createList("l1", "x".repeat(10))]);
    expect(await socket.next()).toEqual({ type: "poke" });
  });

  test("preview: newest by seq, or a validated per-collection sort", async () => {
    const scope = uniqueScope();
    await httpPush(scope, [createList("b"), createList("a"), createList("c"), createList("gone")]);
    await httpPush(scope, [
      listEvent({ type: "delete", id: "gone", rev: 2 }),
      listEvent({ type: "create", collection: "items", id: '["a",1]', data: { title: "t" } }),
    ]);
    await runInDurableObject(env.TEST_SYNC.getByName(scope), (_instance, state) => {
      // Written past write(): no revision, left out of previews.
      state.storage.sql.exec("INSERT INTO lists (id, name) VALUES ('raw', '0')");
    });
    const socket = await openSocket(scope);
    const ids = async (collections: Record<string, unknown>) => {
      socket.send({ type: "preview", collections, limit: 2 } as never);
      const message = await socket.next();
      return message.type === "preview" ? message.changes.map((change) => change.id) : message;
    };
    expect(await ids({ lists: null })).toEqual(["c", "a"]);
    expect(await ids({ items: { column: "title", direction: "asc" } })).toEqual(['["a",1]']);
    expect(await ids({ lists: { column: "name", direction: "asc" } })).toEqual(["a"]);
    expect(await ids({ lists: { column: "name", direction: "desc" } })).toEqual(["c", "b"]);
    expect(
      await ids({
        nope: null,
        items: { column: "nope", direction: "asc" },
        lists: { column: "name", direction: "sideways" },
      }),
    ).toEqual([]);
  });

  test("an expired token gets unauthenticated, is refreshed by auth, then closes with 4001", async () => {
    const scope = uniqueScope();
    await httpPush(scope, [createList("l1")]);
    const socket = await openSocket(scope, Date.now() - 1);
    socket.send({ type: "push", requestId: "p1", events: [createList("l2")] });
    expect(await socket.next()).toEqual({ type: "unauthenticated" });
    expect(await socket.next()).toEqual({
      type: "push-result",
      requestId: "p1",
      reply: { ok: false, reason: "unauthenticated" },
    });
    socket.send({ type: "auth", token: "not-a-token" });
    socket.send({ type: "auth", token: token(scope) });
    expect(await socketPush(socket, [createList("l2")])).toMatchObject({ ok: true });
    // Expired again, and ignored twice: closed.
    socket.send({ type: "auth", token: token(scope, Date.now() - 1) });
    socket.send({ type: "preview", collections: { lists: null }, limit: 1 });
    expect(await socket.next()).toEqual({ type: "unauthenticated" });
    socket.send({ type: "preview", collections: { lists: null }, limit: 1 });
    expect((await socket.closed).code).toBe(CLOSE_UNAUTHENTICATED);
  });

  test("auth for another principal refuses pushes and sends nothing more", async () => {
    const scope = uniqueScope();
    const socket = await openSocket(scope);
    await pullAll(socket, { type: "pull", checkpoints: { lists: null } });
    socket.send({ type: "auth", token: token("someone-else") });
    socket.send({ type: "push", requestId: "p1", events: [createList("l1")] });
    expect(await socket.next()).toEqual({
      type: "push-result",
      requestId: "p1",
      reply: { ok: false, reason: "rejected", index: 0, code: "permission-denied" },
    });
    socket.send({ type: "pull", checkpoints: { lists: null } });
    await httpPush(scope, [createList("l2")]);
    socket.send({ type: "push", requestId: "p2", events: [] });
    expect(await socket.next()).toMatchObject({ type: "push-result", requestId: "p2" });
  });

  test("an object without authenticate() ignores auth", async () => {
    const scope = uniqueScope();
    const socket = await openSocket(scope, Date.now() - 1, "/plain/sync");
    socket.send({ type: "auth", token: token(scope) });
    socket.send({ type: "preview", collections: { lists: null }, limit: 1 });
    expect(await socket.next()).toEqual({ type: "unauthenticated" });
  });
});
