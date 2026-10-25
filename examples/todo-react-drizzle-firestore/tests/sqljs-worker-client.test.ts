import { afterEach, expect, test, vi } from "vite-plus/test";
import { loadPersistedDb } from "../src/db/sqljs-worker-client";

type RequestLike = {
  result?: unknown;
  error?: Error;
  onsuccess?: () => void;
  onerror?: () => void;
};

function stubIndexedDb(read: (request: RequestLike) => void) {
  const getRequest: RequestLike = {};
  const database = {
    objectStoreNames: { contains: () => true },
    transaction: () => ({
      objectStore: () => ({
        get: () => {
          queueMicrotask(() => read(getRequest));
          return getRequest;
        },
      }),
    }),
    close: vi.fn(),
  };
  const openRequest: RequestLike = { result: database };
  vi.stubGlobal("indexedDB", {
    open: () => {
      queueMicrotask(() => openRequest.onsuccess?.());
      return openRequest;
    },
  });
  return { database, getRequest };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("a new local database opens empty when no IndexedDB or legacy snapshot exists", async () => {
  stubIndexedDb((request) => {
    request.onsuccess?.();
  });
  const getItem = vi.fn(() => null);
  vi.stubGlobal("localStorage", { getItem, removeItem: vi.fn() });

  await expect(loadPersistedDb()).resolves.toBeNull();
  expect(getItem).toHaveBeenCalledWith("ez-sync-todo-sqljs");
});

test("an IndexedDB snapshot read failure is surfaced without falling back to an empty database", async () => {
  const failure = new Error("IndexedDB read failed");
  const { database } = stubIndexedDb((request) => {
    request.error = failure;
    request.onerror?.();
  });
  const getItem = vi.fn(() => null);
  vi.stubGlobal("localStorage", { getItem, removeItem: vi.fn() });

  await expect(loadPersistedDb()).rejects.toBe(failure);
  expect(database.close).toHaveBeenCalledOnce();
  expect(getItem).not.toHaveBeenCalled();
});

test("an unsupported stored snapshot format is surfaced as corruption", async () => {
  stubIndexedDb((request) => {
    request.result = { corrupt: true };
    request.onsuccess?.();
  });
  vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), removeItem: vi.fn() });

  await expect(loadPersistedDb()).rejects.toThrow("unsupported format");
});
