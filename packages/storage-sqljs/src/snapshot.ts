const STORE = "database";
const KEY = "snapshot";

export interface SnapshotLocation {
  /** IndexedDB database name. */
  name: string;
  factory: IDBFactory;
}

function openDatabase({ name, factory }: SnapshotLocation): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function toArrayBuffer(view: ArrayBufferView): ArrayBuffer {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice().buffer;
}

/** The last persisted database image, or `null` when nothing was saved yet. */
export async function loadSnapshot(location: SnapshotLocation): Promise<ArrayBuffer | null> {
  const db = await openDatabase(location);
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (value === undefined) return null;
    if (value instanceof ArrayBuffer) return value;
    // Older snapshots were stored as the Uint8Array returned by `db.export()`.
    if (ArrayBuffer.isView(value)) return toArrayBuffer(value);
    throw new Error("The persisted sql.js snapshot has an unsupported format.");
  } finally {
    db.close();
  }
}

export async function saveSnapshot(location: SnapshotLocation, image: Uint8Array): Promise<void> {
  const db = await openDatabase(location);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(toArrayBuffer(image), KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
