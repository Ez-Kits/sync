import { expect, test, vi } from "vite-plus/test";
import { ChangeBus } from "../src/change-bus";
import { createLocalMutationSink } from "../src/collection/local-mutation";
import {
  primaryFields,
  primaryKeyEntries,
  primaryKeyOf,
  recordIdOf,
} from "../src/collection/primary-key";
import { CollectionRuntime } from "../src/collection/runtime";
import { BaseSyncHandler } from "../src/sync-handler/base-sync-handler";
import { createTestLocalChangeStore } from "./helpers/local-change-store";
import { atomicMemoryStore, makeDb } from "./helpers/storage";

const single = { name: "todos", primaryField: "id" };
const composite = { name: "items", primaryField: ["listId", "position"] };

test("primaryFields lists the key fields in order and rejects empty or repeated ones", () => {
  expect(primaryFields(single)).toEqual(["id"]);
  expect(primaryFields(composite)).toEqual(["listId", "position"]);
  expect(() => primaryFields({ name: "items", primaryField: [] })).toThrow(
    'Collection "items" needs distinct fields in its composite primary key, got [].',
  );
  expect(() => primaryFields({ name: "items", primaryField: ["a", "a"] })).toThrow('got ["a","a"]');
});

test("primaryKeyOf reads the field value, or an object of every key field", () => {
  const row = { id: 1, listId: "l1", position: 2, label: "x" };
  expect(primaryKeyOf(single, row)).toBe(1);
  expect(primaryKeyOf(composite, row)).toEqual({ listId: "l1", position: 2 });
});

test("primaryKeyEntries pairs fields with values and rejects the wrong key shape", () => {
  expect(primaryKeyEntries(single, 1)).toEqual([["id", 1]]);
  expect(() => primaryKeyEntries(single, { id: 1 })).toThrow(
    'Collection "todos" has a single primary field "id": pass its value, not an object.',
  );
  expect(primaryKeyEntries(composite, { listId: "l1", position: 2, extra: true })).toEqual([
    ["listId", "l1"],
    ["position", 2],
  ]);
  expect(() => primaryKeyEntries(composite, "l1")).toThrow(
    'Collection "items" has a composite primary key ["listId","position"]: pass an object of ' +
      "its fields, got string.",
  );
});

test("recordIdOf keeps single keys as strings and encodes composite keys as a JSON array", () => {
  expect(recordIdOf(single, "a")).toBe("a");
  expect(recordIdOf(single, 7)).toBe("7");
  expect(() => recordIdOf(single, undefined)).toThrow(
    'needs a string or number value in its primary field "id", got undefined.',
  );
  expect(recordIdOf(composite, { position: 2, listId: "l1" })).toBe('["l1",2]');
  expect(() => recordIdOf(composite, null)).toThrow("pass an object of its fields, got null.");
  expect(() => recordIdOf(composite, { listId: "l1" })).toThrow(
    'needs a string or number value in its primary field "position", got undefined.',
  );
});

test("collection runtime writes composite keys to the outbox", async () => {
  const db = makeDb();
  const store = atomicMemoryStore();
  const runtime = new CollectionRuntime(
    { ...composite, adapterConfig: {} } as never,
    {
      resolve: async () => ({ dbAdapter: db, mutations: createLocalMutationSink(db, store) }),
    },
    new ChangeBus(),
  );
  await runtime.insert({ listId: "l1", position: 1, label: "a" } as never);
  await runtime.update({ listId: "l1", position: 1, label: "b" } as never);
  await runtime.delete({ listId: "l1", position: 1 } as never);
  await expect(runtime.update({ listId: "l1", label: "c" } as never)).rejects.toThrow(
    'primary field "position", got undefined',
  );
  const pending = await store.getPendingEvents("items");
  expect(pending.map(({ recordId }) => recordId)).toEqual(['["l1",1]', '["l1",1]', '["l1",1]']);
  expect(pending[2]).toMatchObject({ type: "delete", data: { id: { listId: "l1", position: 1 } } });
  expect(await store.getDirtyRecords("items")).toEqual([
    expect.objectContaining({ recordId: '["l1",1]', state: "deleted" }),
  ]);
});

test("sync handler matches pulled composite events to dirty records and reads them by key", async () => {
  const db = {
    get: vi.fn(async () => ({ listId: "l1", position: 1, label: "local" })),
    transaction: vi.fn(),
  };
  const localChangeStore = createTestLocalChangeStore();
  class Harness extends BaseSyncHandler<any, any, any> {
    protected requestPush() {}
    resolve(event: any) {
      return this.resolveRemoteEvent(event, { operations: this.config.db, native: undefined });
    }
  }
  const resolveConflict = vi.fn(() => "local" as const);
  const handler = new Harness({
    collections: [{ ...composite, adapterConfig: {} }],
    db,
    changeBus: new ChangeBus<any>(),
    checkpointStorage: { getCheckpoint: vi.fn(), saveCheckpoint: vi.fn() },
    localChangeStore,
    resolveConflict,
  } as never);
  await localChangeStore.upsertDirtyRecord({
    collection: "items",
    recordId: '["l1",1]',
    state: "dirty",
    updatedAt: 1,
  });

  const update = {
    type: "update",
    collection: "items",
    data: { listId: "l1", position: 1, label: "remote" },
  };
  expect(await handler.resolve(update)).toEqual({ needsPush: false });
  expect(db.get).toHaveBeenCalledWith("items", { listId: "l1", position: 1 });

  const deletion = { type: "delete", collection: "items", id: { listId: "l1", position: 1 } };
  expect(await handler.resolve(deletion)).toEqual({ needsPush: false });
  expect(db.get).toHaveBeenLastCalledWith("items", { listId: "l1", position: 1 });
  expect(resolveConflict).toHaveBeenCalledTimes(2);

  const other = { type: "delete", collection: "items", id: { listId: "l1", position: 2 } };
  expect(await handler.resolve(other)).toEqual({ event: other, needsPush: false });
});
