import { afterEach, expect, test, vi } from "vite-plus/test";
import { ChangeBus } from "../src/change-bus";
import { ChangeBusStreamChannel } from "../src/change-bus/change-bus-stream-channel";
import { createLocalStorageCheckpointStorage } from "../src/checkpoint-storage/local-storage";

type Event = { todos: { create: { id: string }; update: { id: string }; delete: string } };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("checkpoint storage serializes per collection, deserializes, and removes empty serialization", async () => {
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  });
  const storage = createLocalStorageCheckpointStorage<string, number>({
    key: "sync",
    serializer: (n) => (n > 0 ? String(n) : undefined),
    deserializer: (raw) => Number(raw),
  });
  expect(await storage.getCheckpoint("todos")).toBeUndefined();
  await storage.saveCheckpoint("todos", 8);
  await storage.saveCheckpoint("users", 4);
  expect(await storage.getCheckpoint("todos")).toBe(8);
  expect(await storage.getCheckpoint("users")).toBe(4);
  await storage.saveCheckpoint("todos", 0);
  expect(await storage.getCheckpoint("todos")).toBeUndefined();
});

test("change bus batches, filters collections and streams, deduplicates subscriptions, and unsubscribes", async () => {
  const bus = new ChangeBus<Event>();
  const local = vi.fn();
  const remote = vi.fn();
  const all = vi.fn();
  const stop = bus.subscribe(["todos"], local, { stream: "local" });
  bus.subscribe(remote, { stream: "remote" });
  bus.subscribe(all);
  bus.publishLocalBatch([
    { type: "create", collection: "todos", data: { id: "1" } },
    { type: "create", collection: "users", data: { id: "2" } },
  ] as never);
  bus.publishLocal({ type: "update", collection: "todos", data: { id: "same-turn" } } as never);
  bus.publishRemote({ type: "delete", collection: "todos", id: "3" } as never);
  bus.publishLocal({ type: "update", collection: "users", data: { id: "filtered" } } as never);
  await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
  expect(local).toHaveBeenCalledTimes(1);
  expect(local.mock.calls[0]?.[0]).toHaveLength(2);
  expect(remote).toHaveBeenCalledTimes(1);
  expect(all).toHaveBeenCalledTimes(2);
  bus.publishLocal({ type: "update", collection: "users", data: { id: "filtered-only" } } as never);
  await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
  expect(local).toHaveBeenCalledOnce();
  stop();
  bus.publishLocal({ type: "update", collection: "todos", data: { id: "1" } } as never);
  await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
  expect(local).toHaveBeenCalledTimes(1);
});

test("change bus rejects invalid scoped subscribe arguments", () => {
  const bus = new ChangeBus<Event>();
  expect(() => (bus.subscribe as (...args: unknown[]) => unknown)("todos", undefined)).toThrow(
    TypeError,
  );
});

test("stream channel deduplicates events and its returned unsubscribe is idempotent", async () => {
  const channel = new ChangeBusStreamChannel<Event>();
  const listener = vi.fn();
  const unsubscribe = channel.subscribe(listener);
  const update = { type: "update", collection: "todos", data: { id: "1" } } as never;
  channel.publish(update);
  channel.publish(update);
  await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
  unsubscribe();
  channel.publish(update);
  await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
  expect(listener).toHaveBeenCalledOnce();
});
