import { vi } from "vite-plus/test";
import type { DBRole, DBStorage } from "../../src/db-storage";
import { createTestLocalChangeStore } from "./local-change-store";

export const collection = { name: "todos", adapterConfig: {}, primaryField: "id" };

/** In-memory rows shared by every adapter built on the same engine. */
export function createEngine() {
  return new Map<string, Record<string, unknown>>();
}

export type FakeDBStorage = DBStorage & {
  role: DBRole;
  close: ReturnType<typeof vi.fn>;
  setRole(role: DBRole): void;
  invalidate(): void;
  fail(error: unknown): void;
};

/** A DBStorage whose role, invalidations and errors the test drives. */
export function fakeDBStorage(
  options: { role?: DBRole; key?: string; ready?: Promise<void> } = {},
): FakeDBStorage {
  const roleListeners = new Set<(role: DBRole) => void>();
  const invalidateListeners = new Set<() => void>();
  const errorListeners = new Set<(error: unknown) => void>();
  const storage: FakeDBStorage = {
    dialect: "sqlite",
    key: options.key ?? "default",
    ready: options.ready ?? Promise.resolve(),
    role: options.role ?? "leader",
    exec: vi.fn(async () => ({ rows: [] })),
    transaction: vi.fn(async (fn) => fn(storage)) as DBStorage["transaction"],
    onRoleChange: (listener) => {
      roleListeners.add(listener);
      return () => roleListeners.delete(listener);
    },
    onInvalidate: (listener) => {
      invalidateListeners.add(listener);
      return () => invalidateListeners.delete(listener);
    },
    onError: (listener) => {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    close: vi.fn(async () => {}),
    setRole(role) {
      storage.role = role;
      for (const listener of roleListeners) listener(role);
    },
    invalidate() {
      for (const listener of invalidateListeners) listener();
    },
    fail(error) {
      for (const listener of errorListeners) listener(error);
    },
  };
  return storage;
}

/**
 * Storages of several simulated tabs: the first joined leads; closing the leader
 * promotes the next one and invalidates the rest, like the worker election does.
 */
export function storageGroup() {
  const members: FakeDBStorage[] = [];
  return {
    members,
    join(): FakeDBStorage {
      const storage = fakeDBStorage({ role: members.length === 0 ? "leader" : "follower" });
      members.push(storage);
      storage.close.mockImplementation(async () => {
        const index = members.indexOf(storage);
        if (index < 0) return;
        members.splice(index, 1);
        if (storage.role !== "leader" || members.length === 0) return;
        members[0]!.setRole("leader");
        for (const member of members) member.invalidate();
      });
      return storage;
    },
  };
}

export function makeDb(
  rows = createEngine(),
  store: any = atomicMemoryStore(),
  dbStorage: DBStorage = fakeDBStorage(),
) {
  const db: any = {
    rows,
    dbStorage,
    localChangeStore: store,
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
    initialize: vi.fn(async () => {}),
    atomicLocalMutationCapability: "atomic" as const,
  };
}

export function clientConfig(dbAdapter: unknown, extra: Record<string, unknown> = {}) {
  return {
    collections: [collection],
    checkpointStorage: {
      getCheckpoint: vi.fn(async () => undefined),
      saveCheckpoint: vi.fn(async () => {}),
    },
    dbAdapter,
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
