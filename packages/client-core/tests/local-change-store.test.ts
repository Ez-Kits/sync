import { expect, test } from "vite-plus/test";
import { createMemoryLocalChangeStore } from "../src/local-change-store/memory";

test("memory outbox returns queued events in creation order and retains them until acknowledged", async () => {
  const store = createMemoryLocalChangeStore();
  await store.appendEvents([
    { id: "later", type: "update", collection: "todos", recordId: "1", createdAt: 2 },
    { id: "first", type: "create", collection: "todos", recordId: "1", createdAt: 1 },
  ]);

  expect((await store.getPendingEvents("todos")).map((event) => event.id)).toEqual([
    "first",
    "later",
  ]);
  await store.deleteEvents(["first"]);
  expect((await store.getPendingEvents("todos")).map((event) => event.id)).toEqual(["later"]);
});

test("leases exclude another owner and issue a new fencing token after expiry", async () => {
  const store = createMemoryLocalChangeStore();
  const first = await store.acquireLease!("app", "tab-a", 100, 50);
  expect(first).toBe(1);
  expect(await store.acquireLease!("app", "tab-b", 120, 50)).toBeUndefined();
  expect(await store.acquireLease!("app", "tab-b", 151, 50)).toBe(2);
  await store.releaseLease!("app", "tab-a", first!);
  expect(await store.acquireLease!("app", "tab-b", 152, 50)).toBe(2);
  await store.releaseLease!("app", "tab-b", 2);
  expect(await store.acquireLease!("app", "tab-b", 153, 50)).toBe(3);
});
