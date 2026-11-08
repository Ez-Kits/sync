/**
 * Where this browser keeps the database: OPFS, or IndexedDB where OPFS is refused, as in
 * private browsing. Decided here once, and not by catching a failed open: a passing OPFS
 * error must surface, not switch the app to an empty IndexedDB database.
 */
async function detectVfs(): Promise<"opfs" | "indexeddb"> {
  try {
    await navigator.storage.getDirectory();
    return "opfs";
  } catch {
    return "indexeddb";
  }
}

export const todoVfs = await detectVfs();
