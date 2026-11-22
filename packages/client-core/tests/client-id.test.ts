import { expect, test, vi } from "vite-plus/test";
import { CLIENT_ID_KEY, readClientId } from "../src/sync-handler/client-id";
import { GlobalSyncHandler } from "../src/sync-handler/global-sync-handler";
import { createTestLocalChangeStore } from "./helpers/local-change-store";
import { ChangeBus } from "../src/change-bus";

test("the client id is created once, stored with the outbox, and read back by a reopened store", async () => {
  const store = createTestLocalChangeStore();
  const [first, second] = await Promise.all([readClientId(store), readClientId(store)]);
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  expect(second).toBe(first);
  expect(await store.getCheckpoint(CLIENT_ID_KEY)).toBe(first);
  // Another store object over the same data: a reload, or another tab on the database.
  expect(await readClientId({ ...store })).toBe(first);
  // Wiped storage: a new id.
  expect(await readClientId(createTestLocalChangeStore())).not.toBe(first);
});

test("a failed read is tried again by the next call", async () => {
  const store = createTestLocalChangeStore();
  const failure = new Error("storage closed");
  vi.spyOn(store, "getCheckpoint").mockRejectedValueOnce(failure);
  await expect(readClientId(store)).rejects.toBe(failure);
  expect(await readClientId(store)).toBe(await store.getCheckpoint(CLIENT_ID_KEY));
});

test("pushes carry the database's client id", async () => {
  const store = createTestLocalChangeStore();
  const push = vi.fn(async ({ events, commitChanges }: any) => commitChanges({ events }));
  const db = {
    transaction: vi.fn(async (fn: any) => fn(db, { operations: db, native: undefined })),
    dbStorage: { isLeader: () => true, onLeaderChange: () => () => {} },
  };
  await store.appendEvents([
    { id: "e1", type: "create", collection: "todos", recordId: "1", data: { id: 1 }, createdAt: 1 },
  ]);
  const handler = new GlobalSyncHandler({
    collections: [{ name: "todos", primaryField: "id" }],
    db,
    changeBus: new ChangeBus(),
    localChangeStore: store,
    checkpointStorage: { getCheckpoint: vi.fn(), saveCheckpoint: vi.fn() },
    syncAdapter: { collections: ["todos"], push, pull: vi.fn() },
  } as never);
  handler.start();
  await vi.waitFor(() => expect(push).toHaveBeenCalled());
  expect(push.mock.calls[0]![0].clientId).toBe(await readClientId(store));
  handler.stop();
});
