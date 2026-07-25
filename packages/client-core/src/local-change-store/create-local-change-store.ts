import { createIndexedDBLocalChangeStore, isIndexedDBAvailable } from "./indexed-db";
import { createMemoryLocalChangeStore } from "./memory";
import type { ILocalChangeStore } from "./types";

/**
 * Creates the local change store used to persist pending ChangeBusEvents.
 * Prefers IndexedDB in browsers; falls back to in-memory when unavailable.
 */
export function createLocalChangeStore(): ILocalChangeStore {
  if (isIndexedDBAvailable()) {
    return createIndexedDBLocalChangeStore();
  }
  return createMemoryLocalChangeStore();
}
