import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test, vi } from "vite-plus/test";
import type { PushReply, Row } from "../src/server.ts";
import { httpPush, httpPull, listEvent, openSocket, socketPush, uniqueScope } from "./helpers.ts";

type Push = (scope: string, events: unknown, clientId?: unknown) => Promise<PushReply>;

const transports: Record<string, Push> = {
  http: (scope, events, clientId) => httpPush(scope, events, undefined, clientId),
  socket: async (scope, events, clientId) => socketPush(await openSocket(scope), events, clientId),
};

function storedRows(scope: string) {
  return runInDurableObject(env.TEST_SYNC.getByName(scope), (_instance, state) => ({
    lists: state.storage.sql.exec("SELECT * FROM lists ORDER BY id").toArray(),
    items: state.storage.sql.exec("SELECT * FROM items ORDER BY list_id, position").toArray(),
    records: state.storage.sql
      .exec("SELECT collection, id, rev, seq, deleted FROM ez_sync_records ORDER BY seq")
      .toArray(),
  }));
}

// The same cases over both transports prove they share one push function.
describe.each(Object.entries(transports))("push over %s", (_name, push) => {
  test("applies creates, updates and deletes with rising seq", async () => {
    const scope = uniqueScope();
    const reply = await push(scope, [
      listEvent({ eventId: "a", type: "create", id: "l1", data: { name: "One" } }),
      listEvent({ eventId: "b", type: "update", id: "l1", rev: 2, data: { name: "Uno" } }),
      listEvent({ eventId: "c", type: "create", id: "l2", data: { name: "Two", createdAt: 5 } }),
      listEvent({ eventId: "d", type: "delete", id: "l2", rev: 2 }),
    ]);
    expect(reply).toEqual({
      ok: true,
      applied: [
        { eventId: "a", rev: 1 },
        { eventId: "b", rev: 2 },
        { eventId: "c", rev: 1 },
        { eventId: "d", rev: 2 },
      ],
    });
    expect(await storedRows(scope)).toMatchObject({
      lists: [{ id: "l1", name: "Uno", created_at: 0 }],
      records: [
        { collection: "lists", id: "l1", rev: 2, seq: 2, deleted: 0 },
        { collection: "lists", id: "l2", rev: 2, seq: 4, deleted: 1 },
      ],
    });
  });

  test("skips an applied push when it repeats", async () => {
    const scope = uniqueScope();
    const events = [listEvent({ type: "create", id: "l1", data: { name: "One" } })];
    const first = await push(scope, events);
    expect(await push(scope, events)).toEqual(first);
    expect((await storedRows(scope)).records).toHaveLength(1);
  });

  test("a resend of two writes to one record answers both with the stored rev, unchanged", async () => {
    const scope = uniqueScope();
    const events = [
      listEvent({ eventId: "a", type: "create", id: "l1", data: { name: "One" } }),
      listEvent({ eventId: "b", type: "update", id: "l1", rev: 2, data: { name: "Uno" } }),
    ];
    await push(scope, events);
    const before = await storedRows(scope);
    // The reply was lost: the device sends the same batch again.
    expect(await push(scope, events)).toEqual({
      ok: true,
      applied: [
        { eventId: "a", rev: 2 },
        { eventId: "b", rev: 2 },
      ],
    });
    expect(await storedRows(scope)).toEqual(before);
  });

  test("a retry after a rejection is applied", async () => {
    const scope = uniqueScope();
    const ok = listEvent({ type: "create", id: "l1", data: { name: "One" } });
    const bad = listEvent({ type: "create", id: "l2", data: { name: "bad" } });
    expect(await push(scope, [ok, bad])).toMatchObject({ ok: false, reason: "rejected" });
    // Core parks the refused event and pushes the rest again with the same revs.
    expect(await push(scope, [ok])).toEqual({
      ok: true,
      applied: [{ eventId: ok.eventId, rev: 1 }],
    });
    expect(await push(scope, [{ ...bad, data: { name: "Two" } }])).toMatchObject({ ok: true });
    expect((await storedRows(scope)).lists).toMatchObject([{ name: "One" }, { name: "Two" }]);
  });

  test("the same rev from another device is a conflict", async () => {
    const scope = uniqueScope();
    await push(scope, [listEvent({ type: "create", id: "l1", data: { name: "One" } })]);
    const other = [listEvent({ type: "create", id: "l1", data: { name: "Other" } })];
    expect(await push(scope, other, "device-b")).toMatchObject({ ok: false, reason: "conflict" });
    expect(await push(scope, other, null)).toMatchObject({ ok: false, reason: "conflict" });
  });

  test("a server write after the device's makes its resend a conflict", async () => {
    const scope = uniqueScope();
    const events = [listEvent({ type: "create", id: "l1", data: { name: "One" } })];
    await push(scope, events);
    await runInDurableObject(env.TEST_SYNC.getByName(scope), (instance) =>
      instance.write([{ collection: "lists", type: "update", id: "l1", data: { name: "Server" } }]),
    );
    expect(await push(scope, events)).toMatchObject({
      ok: false,
      reason: "conflict",
      records: [{ id: "l1", rev: 2, data: { name: "Server" } }],
    });
  });

  test("a clientId that isn't a string is refused", async () => {
    const reply = await push(uniqueScope(), [listEvent({ type: "create", id: "l1" })], 7);
    expect(reply).toEqual({ ok: false, reason: "rejected", index: 0, code: "invalid-argument" });
  });

  test("a conflict carries every conflicting record and saves nothing", async () => {
    const scope = uniqueScope();
    await push(scope, [
      listEvent({ type: "create", id: "live", data: { name: "Live" } }),
      listEvent({ type: "create", id: "gone", data: { name: "Gone" } }),
      listEvent({ type: "delete", id: "gone", rev: 2 }),
    ]);
    const reply = await push(
      scope,
      [
        listEvent({ type: "create", id: "fresh", data: { name: "Fresh" } }),
        listEvent({ type: "update", id: "live", rev: 1, data: { name: "Stale" } }),
        listEvent({ type: "update", id: "live", rev: 2, data: { name: "Stale" } }),
        listEvent({ type: "update", id: "gone", rev: 2, data: { name: "Stale" } }),
        listEvent({ type: "update", id: "never", rev: 3, data: { name: "Stale" } }),
        // Stale writes from another device: the same ones from this device would be resends.
      ],
      "device-b",
    );
    expect(reply).toEqual({
      ok: false,
      reason: "conflict",
      records: [
        {
          collection: "lists",
          id: "live",
          rev: 1,
          deleted: false,
          data: { id: "live", name: "Live", createdAt: 0 },
        },
        { collection: "lists", id: "gone", rev: 2, deleted: true },
        { collection: "lists", id: "never", rev: 0, deleted: true },
      ],
    });
    expect((await storedRows(scope)).lists.map((row) => row.id)).toEqual(["live"]);
  });

  test("a rejection inside a batch saves nothing", async () => {
    const scope = uniqueScope();
    const reply = await push(scope, [
      listEvent({ type: "create", id: "l1", data: { name: "One" } }),
      listEvent({ type: "create", id: "l2", data: { name: "bad" } }),
    ]);
    expect(reply).toEqual({ ok: false, reason: "rejected", index: 1, code: "invalid-argument" });
    expect(await storedRows(scope)).toMatchObject({ lists: [], records: [] });
  });

  test.each([
    ["no array", undefined, "invalid-argument"],
    ["a null event", [null], "invalid-argument"],
    ["no event id", [{ type: "create", collection: "lists", id: "l", rev: 1 }], "invalid-argument"],
    ["an unknown type", [listEvent({ type: "upsert" as "create", id: "l" })], "invalid-argument"],
    ["no rev", [listEvent({ type: "create", id: "l", rev: 1.5 })], "invalid-argument"],
    [
      "an unknown collection",
      [listEvent({ type: "create", id: "l", collection: "nope" })],
      "unknown-collection",
    ],
    [
      "a prototype key",
      [listEvent({ type: "create", id: "l", collection: "constructor" })],
      "unknown-collection",
    ],
    [
      "a numeric collection",
      [listEvent({ type: "create", id: "l", collection: 5 as unknown as string })],
      "unknown-collection",
    ],
    [
      "a numeric id",
      [listEvent({ type: "create", id: 5 as unknown as string })],
      "invalid-argument",
    ],
    [
      "array data",
      [listEvent({ type: "create", id: "l", data: [] as unknown as Row })],
      "invalid-argument",
    ],
    [
      "null data",
      [listEvent({ type: "create", id: "l", data: null as unknown as Row })],
      "invalid-argument",
    ],
    [
      "an unknown column",
      [listEvent({ type: "create", id: "l", data: { name: "x", color: 1 } })],
      "unknown-column",
    ],
    [
      "a missing NOT NULL column",
      [listEvent({ type: "create", id: "l", data: {} })],
      "invalid-argument",
    ],
  ])("rejects %s", async (_case, events, code) => {
    expect(await push(uniqueScope(), events)).toEqual({
      ok: false,
      reason: "rejected",
      index: 0,
      code,
    });
  });

  test.each([
    ["not JSON", "x"],
    ["not an array", '"a"'],
    ["a short array", '["a"]'],
    ["a boolean key", '["a",true]'],
  ])("rejects a composite id that is %s", async (_case, id) => {
    const reply = await push(uniqueScope(), [
      listEvent({ type: "create", collection: "items", id, data: { title: "t" } }),
    ]);
    expect(reply).toEqual({ ok: false, reason: "rejected", index: 0, code: "invalid-argument" });
  });

  test("rejects a request over the byte limit", async () => {
    const scope = uniqueScope();
    await runInDurableObject(env.TEST_SYNC.getByName(scope), (instance) => {
      instance.maxMessageBytes = 100;
    });
    const reply = await push(scope, [
      listEvent({ type: "create", id: "l1", data: { name: "x".repeat(100) } }),
    ]);
    expect(reply).toEqual({ ok: false, reason: "rejected", index: 0, code: "too-large" });
  });
});

describe("push", () => {
  test("a composite key maps to its columns in order", async () => {
    const scope = uniqueScope();
    const reply = await httpPush(scope, [
      listEvent({ type: "create", id: "l1", data: { name: "One" } }),
      listEvent({ type: "create", collection: "items", id: '["l1",2]', data: { title: "Two" } }),
    ]);
    expect(reply.ok).toBe(true);
    expect((await storedRows(scope)).items).toEqual([
      { list_id: "l1", position: 2, title: "Two", done: 0 },
    ]);
  });

  test("a create replaces the whole row in place: child rows survive", async () => {
    const scope = uniqueScope();
    await httpPush(scope, [
      listEvent({ type: "create", id: "l1", data: { name: "One", createdAt: 7 } }),
      listEvent({
        type: "create",
        collection: "items",
        id: '["l1",1]',
        data: { title: "Child", done: 1 },
      }),
    ]);
    const reply = await httpPush(scope, [
      listEvent({ type: "create", id: "l1", rev: 2, data: { name: "Replaced" } }),
      // Only keys: nothing to set, the row stays.
      listEvent({
        type: "update",
        collection: "items",
        id: '["l1",1]',
        rev: 2,
        data: { listId: "l1" },
      }),
    ]);
    expect(reply.ok).toBe(true);
    const rows = await storedRows(scope);
    // Left out of the create: back to its default.
    expect(rows.lists).toEqual([{ id: "l1", name: "Replaced", created_at: 0 }]);
    expect(rows.items).toEqual([{ list_id: "l1", position: 1, title: "Child", done: 1 }]);
  });

  test("a delete cascades to child rows; a create or update revives a deleted id", async () => {
    const scope = uniqueScope();
    await httpPush(scope, [
      listEvent({ type: "create", id: "l1", data: { name: "One" } }),
      listEvent({ type: "create", id: "l2", data: { name: "Two" } }),
      listEvent({ type: "create", collection: "items", id: '["l1",1]', data: { title: "Child" } }),
      listEvent({ type: "delete", id: "l1", rev: 2, deletedAt: 123 }),
      listEvent({ type: "delete", id: "l2", rev: 2 }),
    ]);
    expect((await storedRows(scope)).items).toEqual([]);
    const reply = await httpPush(scope, [
      listEvent({ type: "create", id: "l1", rev: 3, data: { name: "Back" } }),
      listEvent({ type: "update", id: "l2", rev: 3, data: { name: "Also back" } }),
    ]);
    expect(reply.ok).toBe(true);
    expect((await storedRows(scope)).lists).toEqual([
      { id: "l1", name: "Back", created_at: 0 },
      { id: "l2", name: "Also back", created_at: 0 },
    ]);
  });

  test("validate() sees the event, the current row and the principal", async () => {
    const scope = uniqueScope();
    await httpPush(scope, [listEvent({ type: "create", id: "l1", data: { name: "One" } })]);
    await httpPush(scope, [listEvent({ type: "delete", id: "l1", rev: 2 })]);
    const validated = await runInDurableObject(
      env.TEST_SYNC.getByName(scope),
      (instance) => instance.validated,
    );
    expect(validated).toMatchObject([
      { event: { type: "create", rev: 1 }, current: null, principal: { uid: scope } },
      {
        event: { type: "delete", rev: 2 },
        current: { id: "l1", name: "One" },
        principal: { uid: scope },
      },
    ]);
  });

  test("an error thrown inside the transaction rolls back and propagates", async () => {
    const scope = uniqueScope();
    await runInDurableObject(env.TEST_SYNC.getByName(scope), async (instance) => {
      instance.validate = () => {
        throw new Error("validate failed");
      };
      await expect(
        instance.write([{ collection: "lists", type: "create", id: "l1", data: { name: "x" } }]),
      ).rejects.toThrow("validate failed");
    });
    expect((await storedRows(scope)).records).toEqual([]);
  });

  test("onCommitted() runs after a commit; a throw is logged and the push still succeeds", async () => {
    const scope = uniqueScope();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const reply = await httpPush(scope, [
      listEvent({ type: "create", id: "l1", data: { name: "boom" } }),
    ]);
    expect(reply.ok).toBe(true);
    const committed = await runInDurableObject(
      env.TEST_SYNC.getByName(scope),
      (instance) => instance.committed,
    );
    expect(committed).toMatchObject([
      { source: "device", changes: [{ id: "l1", seq: 1, rev: 1 }] },
    ]);
    expect(error).toHaveBeenCalledWith("ez-sync: onCommitted threw", expect.any(Error));
    error.mockRestore();
  });

  test("an object without hooks applies pushes", async () => {
    const scope = uniqueScope();
    const reply = await httpPush(
      scope,
      [listEvent({ type: "create", id: "l1", data: { name: "bad" } })],
      "/plain/sync/push",
    );
    expect(reply).toEqual({ ok: true, applied: [{ eventId: expect.any(String), rev: 1 }] });
  });

  test("without a clientId, a repeat goes through the rev check", async () => {
    const scope = uniqueScope();
    const event = listEvent({ type: "create", id: "l1", data: { name: "One" } });
    await httpPush(scope, [event], undefined, null);
    expect(await httpPush(scope, [event], undefined, null)).toMatchObject({
      ok: false,
      reason: "conflict",
    });
  });

  test("HTTP pull returns a page without a socket", async () => {
    const scope = uniqueScope();
    await httpPush(scope, [listEvent({ type: "create", id: "l1", data: { name: "One" } })]);
    expect(await httpPull(scope, { type: "pull", checkpoints: { lists: null } })).toEqual({
      type: "changes",
      changes: [
        {
          collection: "lists",
          id: "l1",
          seq: 1,
          rev: 1,
          deleted: false,
          data: { id: "l1", name: "One", createdAt: 0 },
        },
      ],
      checkpoints: { lists: 1 },
      hasMore: false,
    });
    expect(await httpPull(scope, {})).toEqual({
      type: "changes",
      changes: [],
      checkpoints: {},
      hasMore: false,
    });
  });
});
