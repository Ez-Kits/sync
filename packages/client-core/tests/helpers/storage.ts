import { vi } from "vite-plus/test";
import { createCoordinatedStorage } from "../../src/storage-coordination";
import { createTestLocalChangeStore } from "./local-change-store";

export const collection = { name: "todos", adapterConfig: {}, primaryField: "id" };

/** In-memory rows shared by every adapter built on the same engine. */
export function createEngine() {
  return new Map<string, Record<string, unknown>>();
}

export function makeDb(rows = createEngine()) {
  const db: any = {
    rows,
    queryBuilder: { rows },
    querySchema: { todos: {} },
    insert: vi.fn(async (_n: string, row: { id: string }) => {
      if (rows.has(String(row.id))) throw new Error(`duplicate ${row.id}`);
      rows.set(String(row.id), row);
    }),
    update: vi.fn(async (_n: string, row: { id: string }) => {
      rows.set(String(row.id), { ...rows.get(String(row.id)), ...row });
    }),
    delete: vi.fn(async (_n: string, id: string) => {
      rows.delete(String(id));
    }),
    get: vi.fn(async (_n: string, id: string) => rows.get(String(id))),
    getMany: vi.fn(async () => [...rows.values()]),
    transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(db)),
  };
  db.commitLocalMutation = vi.fn(
    async ({ mutate, persistOutboxEvent, persistDirtyRecord }: any) => {
      const context = { operations: db, native: db };
      await mutate(context);
      await persistOutboxEvent(context);
      await persistDirtyRecord(context);
    },
  );
  return db;
}

export function atomicMemoryStore() {
  return {
    ...createTestLocalChangeStore(),
    atomicLocalMutationCapability: "atomic" as const,
  };
}

/** Single-context storage: no tab coordination, this context always owns it. */
export function standaloneStorage(db: any = makeDb(), store: any = atomicMemoryStore()) {
  return createCoordinatedStorage({
    sharing: "shared",
    coordinateTabs: false,
    open: () => ({ database: db }),
    createDBAdapter: (database: any) => database,
    createLocalChangeStore: () => store,
  });
}

export function clientConfig(storage: unknown, extra: Record<string, unknown> = {}) {
  return {
    collections: [collection],
    checkpointStorage: {
      getCheckpoint: vi.fn(async () => undefined),
      saveCheckpoint: vi.fn(async () => {}),
    },
    storage,
    ...extra,
  } as any;
}

export const tick = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

export async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) await tick();
}
