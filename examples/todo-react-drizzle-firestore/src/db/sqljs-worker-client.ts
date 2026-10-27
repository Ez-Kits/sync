type ExecMethod = "run" | "all" | "get";
export type RowMode = "array" | "object";

type WorkerRequest =
  | { id: number; action: "open"; buffer?: ArrayBuffer | null }
  | {
      id: number;
      action: "exec";
      sql: string;
      params?: unknown;
    }
  | { id: number; action: "export" };

type WorkerResponse = {
  id: number;
  ready?: boolean;
  results?: Array<{ columns: string[]; values: unknown[][] }>;
  /** sql.js `db.export()` returns a Uint8Array view, not a bare ArrayBuffer. */
  buffer?: Uint8Array;
  error?: string;
};

const DB_STORAGE_KEY = "ez-sync-todo-sqljs";
const IDB_NAME = "ez-sync-todo-sqljs";
const IDB_STORE = "database";
const IDB_KEY = "snapshot";

/**
 * sql.js `db.export()` closes and reopens the database, which aborts any open
 * transaction. Only persist when no transaction is active.
 */
function transactionDepthDelta(sql: string): number {
  const normalized = sql.trim().toLowerCase();
  if (normalized === "begin" || normalized.startsWith("begin ")) {
    return 1;
  }
  if (
    normalized === "commit" ||
    normalized.startsWith("commit ") ||
    normalized === "end" ||
    normalized.startsWith("end ") ||
    normalized === "rollback" ||
    normalized.startsWith("rollback ")
  ) {
    return -1;
  }
  return 0;
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
  });
}

export class SqlJsWorkerClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: WorkerResponse) => void;
      reject: (error: Error) => void;
    }
  >();
  private ready: Promise<void>;
  /** Open SQLite transactions; persist is unsafe while > 0. */
  private transactionDepth = 0;
  /** When > 0, skip automatic persist (e.g. bulk seed). */
  private persistPauseDepth = 0;

  constructor() {
    // Served from /public — Vite+/Rolldown currently fails bundling Worker modules.
    this.worker = new Worker(`${import.meta.env.BASE_URL}worker.sql-wasm.js`);
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) {
        pending.reject(new Error(response.error));
        return;
      }
      pending.resolve(response);
    };
    this.worker.onerror = (event) => {
      console.error("sql.js worker error", event);
    };
    this.ready = this.bootstrap();
  }

  private request(payload: WorkerRequest): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      this.pending.set(payload.id, { resolve, reject });
      this.worker.postMessage(payload);
    });
  }

  private async bootstrap(): Promise<void> {
    const buffer = await loadPersistedDb();
    await this.request({
      id: this.nextId++,
      action: "open",
      buffer,
    });
  }

  async exec(
    sql: string,
    params: unknown[],
    method: ExecMethod,
    rowMode: RowMode = "array",
  ): Promise<{ rows: unknown }> {
    await this.ready;
    const depthDelta = transactionDepthDelta(sql);

    const response = await this.request({
      id: this.nextId++,
      action: "exec",
      sql,
      params: params.length > 0 ? params : undefined,
    });

    if (depthDelta !== 0) {
      this.transactionDepth = Math.max(0, this.transactionDepth + depthDelta);
    }

    const result = response.results?.[0];
    const values = result?.values ?? [];

    if (method === "run") {
      await this.persistIfIdle();
      return { rows: [] };
    }
    const rows =
      rowMode === "object"
        ? values.map((row) =>
            Object.fromEntries(result!.columns.map((column, index) => [column, row[index]])),
          )
        : values;
    if (method === "get") {
      return { rows: rows[0] };
    }
    return { rows };
  }

  private async persistIfIdle(): Promise<void> {
    if (this.transactionDepth > 0 || this.persistPauseDepth > 0) return;
    await this.persist();
  }

  /** Skip automatic persists until `resumePersist()` (pair for bulk writes). */
  pausePersist(): void {
    this.persistPauseDepth += 1;
  }

  async resumePersist(): Promise<void> {
    this.persistPauseDepth = Math.max(0, this.persistPauseDepth - 1);
    if (this.persistPauseDepth === 0) {
      await this.persist();
    }
  }

  /** Stop the worker; pending requests are rejected. Committed state is already persisted. */
  close(): void {
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      pending.reject(new Error("The local database was closed."));
    }
    this.pending.clear();
  }

  async persist(): Promise<void> {
    if (this.transactionDepth > 0) return;
    await this.ready;
    const response = await this.request({
      id: this.nextId++,
      action: "export",
    });
    if (response.buffer) {
      await savePersistedDb(toArrayBuffer(response.buffer));
    }
  }
}

export async function loadPersistedDb(): Promise<ArrayBuffer | null> {
  const db = await openIdb();
  let fromIdb: ArrayBuffer | null;
  try {
    const persistedValue = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const request = tx.objectStore(IDB_STORE).get(IDB_KEY);
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error("Failed to read IndexedDB"));
    });
    if (persistedValue === undefined) {
      fromIdb = null;
    } else if (persistedValue instanceof ArrayBuffer) {
      fromIdb = persistedValue;
    } else if (ArrayBuffer.isView(persistedValue)) {
      // Snapshots written before export buffers were normalized were stored as Uint8Array.
      fromIdb = toArrayBuffer(persistedValue);
    } else {
      throw new Error("The persisted local database snapshot has an unsupported format.");
    }
  } finally {
    db.close();
  }
  if (fromIdb) return fromIdb;

  // One-time migration from the previous localStorage snapshot format.
  const raw = localStorage.getItem(DB_STORAGE_KEY);
  if (!raw) return null;
  const binary = Uint8Array.from(atob(raw), (char) => char.charCodeAt(0));
  const buffer = binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);
  await savePersistedDb(buffer);
  localStorage.removeItem(DB_STORAGE_KEY);
  return buffer;
}

function toArrayBuffer(view: ArrayBufferView): ArrayBuffer {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice().buffer;
}

async function savePersistedDb(buffer: ArrayBuffer): Promise<void> {
  const db = await openIdb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(buffer, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to write IndexedDB"));
  });
  db.close();
}
