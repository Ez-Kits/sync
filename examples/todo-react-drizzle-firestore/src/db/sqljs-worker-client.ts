type ExecMethod = "run" | "all" | "values" | "get";

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
  buffer?: ArrayBuffer;
  error?: string;
};

const DB_STORAGE_KEY = "ez-sync-todo-sqljs";

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

  async exec(sql: string, params: unknown[], method: ExecMethod): Promise<{ rows: unknown }> {
    await this.ready;
    const response = await this.request({
      id: this.nextId++,
      action: "exec",
      sql,
      params: params.length > 0 ? params : undefined,
    });

    const values = response.results?.[0]?.values ?? [];

    if (method === "run") {
      void this.persist();
      return { rows: [] };
    }
    if (method === "get") {
      return { rows: values[0] };
    }
    return { rows: values };
  }

  async persist(): Promise<void> {
    await this.ready;
    const response = await this.request({
      id: this.nextId++,
      action: "export",
    });
    if (response.buffer) {
      await savePersistedDb(response.buffer);
    }
  }
}

async function loadPersistedDb(): Promise<ArrayBuffer | null> {
  try {
    const raw = localStorage.getItem(DB_STORAGE_KEY);
    if (!raw) return null;
    const binary = Uint8Array.from(atob(raw), (char) => char.charCodeAt(0));
    return binary.buffer;
  } catch {
    return null;
  }
}

async function savePersistedDb(buffer: ArrayBuffer): Promise<void> {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  localStorage.setItem(DB_STORAGE_KEY, btoa(binary));
}
