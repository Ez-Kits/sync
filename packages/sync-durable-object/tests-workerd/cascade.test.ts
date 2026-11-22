import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vite-plus/test";
import { httpPull, httpPush, listEvent, openSocket, pullAll, uniqueScope } from "./helpers.ts";

const create = (collection: string, id: string, data: Record<string, unknown>) =>
  listEvent({ type: "create", collection, id, data });

async function seed(scope: string) {
  await httpPush(scope, [
    create("lists", "l1", { name: "One" }),
    create("lists", "l2", { name: "Two" }),
    create("items", '["l1",1]', { title: "a" }),
    create("items", '["l1",2]', { title: "b" }),
    create("items", '["l2",1]', { title: "c" }),
    create("notes", "n1", { listId: "l1", position: 1, body: "x" }),
    create("notes", "n2", { listId: "l2", position: 1, body: "y" }),
  ]);
}

describe("cascade", () => {
  test("a parent delete tombstones its children and grandchildren, live and in onCommitted", async () => {
    const scope = uniqueScope();
    await seed(scope);
    const socket = await openSocket(scope);
    await pullAll(socket, { type: "pull", checkpoints: { lists: 2, items: 5, notes: 7 } });
    expect(await httpPush(scope, [listEvent({ type: "delete", id: "l1", rev: 2 })])).toMatchObject({
      ok: true,
    });
    const tombstones = [
      { collection: "lists", id: "l1", seq: 8, rev: 2, deleted: true },
      { collection: "items", id: '["l1",1]', seq: 9, rev: 2, deleted: true },
      { collection: "items", id: '["l1",2]', seq: 10, rev: 2, deleted: true },
      { collection: "notes", id: "n1", seq: 11, rev: 2, deleted: true },
    ];
    expect(await socket.next()).toEqual({
      type: "changes",
      changes: tombstones,
      checkpoints: { lists: 8, items: 10, notes: 11 },
      hasMore: false,
    });
    const committed = await runInDurableObject(env.TEST_SYNC.getByName(scope), (instance) =>
      instance.committed.at(-1),
    );
    expect(committed).toEqual({ changes: tombstones, source: "device" });
    // A later pull returns the tombstones; l2's rows are untouched.
    const pulled = await httpPull(scope, {
      type: "pull",
      checkpoints: { lists: null, items: null, notes: null },
    });
    expect(pulled).toMatchObject({
      changes: [
        { id: "l2", deleted: false },
        { id: '["l2",1]', deleted: false },
        { id: "n2", deleted: false },
        ...tombstones,
      ],
    });
    // A device still holding rev 1 of a cascaded child conflicts with the deleted state.
    expect(
      await httpPush(scope, [
        listEvent({ type: "update", collection: "items", id: '["l1",1]', rev: 2, data: {} }),
      ]),
    ).toEqual({
      ok: false,
      reason: "conflict",
      records: [{ collection: "items", id: '["l1",1]', rev: 2, deleted: true }],
    });
  });

  test("a server write() delete cascades the same way", async () => {
    const scope = uniqueScope();
    await seed(scope);
    const results = await runInDurableObject(env.TEST_SYNC.getByName(scope), async (instance) => {
      await instance.write([{ collection: "lists", type: "delete", id: "l2" }]);
      return instance.committed.at(-1)!.changes;
    });
    expect(results).toMatchObject([
      { id: "l2", seq: 8, deleted: true },
      { id: '["l2",1]', seq: 9, deleted: true },
      { id: "n2", seq: 10, deleted: true },
    ]);
  });

  test("a row removed past write() is pulled as deleted, never without data", async () => {
    const scope = uniqueScope();
    await seed(scope);
    await runInDurableObject(env.TEST_SYNC.getByName(scope), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM notes WHERE id = 'n1'");
    });
    expect(await httpPull(scope, { type: "pull", checkpoints: { notes: 5 } })).toMatchObject({
      changes: [
        { id: "n1", seq: 6, rev: 1, deleted: true },
        { id: "n2", seq: 7, deleted: false },
      ],
    });
  });
});
