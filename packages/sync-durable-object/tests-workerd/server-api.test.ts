import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vite-plus/test";
import {
  CLOSE_SCOPE_DELETED,
  SyncRejectedError,
  readSubprotocolToken,
  routeSyncRequest,
} from "../src/server.ts";
import {
  fetchApp,
  httpPull,
  httpPush,
  listEvent,
  openSocket,
  pullAll,
  uniqueScope,
} from "./helpers.ts";
import { token } from "./worker.ts";

describe("server API", () => {
  test("write() takes the next rev, returns rev and seq, and reaches live sockets", async () => {
    const scope = uniqueScope();
    await httpPush(scope, [listEvent({ type: "create", id: "l1", data: { name: "One" } })]);
    const socket = await openSocket(scope);
    await pullAll(socket, { type: "pull", checkpoints: { lists: 1 } });
    const stub = env.TEST_SYNC.getByName(scope);
    const results = await runInDurableObject(stub, (instance) =>
      instance.write([
        { collection: "lists", type: "update", id: "l1", data: { name: "Server" } },
        { collection: "lists", type: "delete", id: "l1" },
      ]),
    );
    expect(results).toEqual([
      { rev: 2, seq: 2 },
      { rev: 3, seq: 3 },
    ]);
    expect(await socket.next()).toMatchObject({ changes: [{ id: "l1", rev: 3, deleted: true }] });
    const committed = await runInDurableObject(stub, (instance) => instance.committed.at(-1));
    expect(committed).toMatchObject({ source: "server" });
  });

  test("write() throws a rejection", async () => {
    await runInDurableObject(env.TEST_SYNC.getByName(uniqueScope()), async (instance) => {
      const write = instance.write([
        { collection: "lists", type: "create", id: "l1", data: { name: "ok" } },
        { collection: "lists", type: "create", id: "l2", data: { name: "bad" } },
      ]);
      await expect(write).rejects.toThrow(new SyncRejectedError(1, "invalid-argument"));
      await expect(write).rejects.toMatchObject({ index: 1, code: "invalid-argument" });
    });
  });

  test("importRows() keeps revs, assigns seq per batch and pokes live sockets", async () => {
    const scope = uniqueScope();
    const socket = await openSocket(scope);
    await pullAll(socket, { type: "pull", checkpoints: { lists: null } });
    const stub = env.TEST_SYNC.getByName(scope);
    await runInDurableObject(stub, (instance) => {
      instance.importBatchSize = 2;
      instance.importRows([
        { collection: "lists", id: "a", data: { name: "A" }, rev: 4 },
        { collection: "lists", id: "b", data: { name: "B" }, rev: 9 },
        { collection: "lists", id: "c", data: { name: "C" }, rev: 1 },
      ]);
      // The second batch rolls back alone.
      expect(() =>
        instance.importRows([
          { collection: "lists", id: "d", data: { name: "D" }, rev: 1 },
          { collection: "lists", id: "e", data: { name: "E" }, rev: 1 },
          { collection: "lists", id: "f", data: { name: "F" }, rev: 1 },
          { collection: "nope", id: "g", data: {}, rev: 1 },
        ]),
      ).toThrow(new SyncRejectedError(3, "unknown-collection"));
    });
    expect(await socket.next()).toEqual({ type: "poke" });
    const page = await httpPull(scope, { type: "pull", checkpoints: { lists: null } });
    expect(page).toMatchObject({
      changes: [
        { id: "a", rev: 4, seq: 1 },
        { id: "b", rev: 9, seq: 2 },
        { id: "c", rev: 1, seq: 3 },
        { id: "d", rev: 1, seq: 4 },
        { id: "e", rev: 1, seq: 5 },
      ],
    });
  });

  test("deleteScope() closes sockets and refuses every later request, even after eviction", async () => {
    const scope = uniqueScope();
    await httpPush(scope, [listEvent({ type: "create", id: "l1", data: { name: "One" } })]);
    const socket = await openSocket(scope);
    const stub = env.TEST_SYNC.getByName(scope);
    await runInDurableObject(stub, (instance) => instance.deleteScope());
    expect((await socket.closed).code).toBe(CLOSE_SCOPE_DELETED);
    await evictDurableObject(stub);
    const refused = { ok: false, reason: "rejected", index: 0, code: "scope-deleted" };
    expect(
      await httpPush(scope, [listEvent({ type: "create", id: "l2", data: { name: "x" } })]),
    ).toEqual(refused);
    const pull = await fetchApp("/sync/pull", {
      method: "POST",
      headers: { Authorization: token(scope) },
      body: "{}",
    });
    expect(pull.status).toBe(410);
    expect((await (await openSocket(scope)).closed).code).toBe(CLOSE_SCOPE_DELETED);
    await runInDurableObject(stub, async (instance, state) => {
      await expect(
        instance.write([{ collection: "lists", type: "delete", id: "l1" }]),
      ).rejects.toMatchObject({
        code: "scope-deleted",
      });
      expect(() => instance.importRows([])).toThrow(SyncRejectedError);
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM lists").one().n).toBe(0);
    });
  });
});

describe("routing", () => {
  test("the object answers only routed /sync requests", async () => {
    const scope = uniqueScope();
    const unrouted = await env.TEST_SYNC.getByName(scope).fetch("http://example.com/sync/push", {
      method: "POST",
    });
    expect(unrouted.status).toBe(404);
    const other = await fetchApp("/other", {
      method: "POST",
      headers: { Authorization: token(scope) },
    });
    expect(other.status).toBe(404);
    const badJson = await fetchApp("/sync/push", {
      method: "POST",
      headers: { Authorization: token(scope) },
      body: "{",
    });
    expect(badJson.status).toBe(400);
  });

  test("routeSyncRequest() forwards to the scope with internal headers and no token", async () => {
    let seen: Request | undefined;
    const namespace = {
      getByName: (name: string) => ({
        fetch: (input: URL, init: RequestInit) => {
          seen = new Request(input, init);
          return Promise.resolve(new Response(name));
        },
      }),
    } as unknown as DurableObjectNamespace;
    const request = new Request("http://example.com/api/sync", {
      headers: { "Sec-WebSocket-Protocol": "ezsync, secret" },
    });
    const response = await routeSyncRequest(request, {
      namespace,
      scope: "u1",
      principal: { uid: "u1" },
      expiresAt: 5,
    });
    expect(await response.text()).toBe("u1");
    expect(seen!.url).toBe("http://example.com/sync");
    expect(seen!.headers.get("Sec-WebSocket-Protocol")).toBe("ezsync");
    expect(seen!.headers.get("x-ez-sync-principal")).toBe('{"uid":"u1"}');
    expect(seen!.headers.get("x-ez-sync-expires-at")).toBe("5");
  });

  test.each([
    [undefined, null],
    ["other, secret", null],
    ["ezsync", null],
    ["ezsync, secret", "secret"],
  ])("readSubprotocolToken(%s) is %s", (header, expected) => {
    const headers: Record<string, string> = header ? { "Sec-WebSocket-Protocol": header } : {};
    expect(readSubprotocolToken(new Request("http://example.com", { headers }))).toBe(expected);
  });
});
