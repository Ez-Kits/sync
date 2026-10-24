import "reflect-metadata";
import { expect, test, vi } from "vite-plus/test";
import { PrimaryColumn } from "typeorm";
import { buildSchemaFromCollections, defineTypeormCollection } from "../src/collection";
import { createTypeOrmDBAdapter } from "../src/create-typeorm-db-adapter";
import { createTypeOrmLocalChangeStore } from "../src/create-typeorm-local-change-store";
import { createTypeOrmStorage } from "../src/create-typeorm-storage";
import type { DirtyRecord, StoredChangeBusEvent } from "@ez-kits/sync-client-core";

class Todo {
  id!: number;
  title!: string;
}

class OutboxEvent implements StoredChangeBusEvent {
  id!: string;
  type!: "create" | "update" | "delete";
  collection!: string;
  data!: unknown;
  recordId!: string;
  createdAt!: number;
}

class DirtyRecordEntity implements DirtyRecord {
  collection!: string;
  recordId!: string;
  state!: "dirty" | "deleted";
  updatedAt!: number;
}
PrimaryColumn("integer")(Todo.prototype, "id");
const collection = defineTypeormCollection({ name: "todos", entity: Todo, primaryField: "id" });

function makeDb(row: unknown = { id: 1, title: "one" }) {
  const calls: unknown[][] = [];
  const repository = {
    save: vi.fn(async (value: unknown) => {
      calls.push(["save", value]);
      return value;
    }),
    delete: vi.fn(async (where: unknown) => {
      calls.push(["delete", where]);
    }),
    findOneOrFail: vi.fn(async (options: unknown) => {
      calls.push(["get", options]);
      if (row == null) throw new Error("missing");
      return row;
    }),
    findOne: vi.fn(async (options: unknown) => {
      calls.push(["optional", options]);
      return row ?? null;
    }),
    find: vi.fn(async () => [row]),
  };
  const db = {
    getRepository: vi.fn(() => repository),
    transaction: vi.fn(async (fn: (manager: any) => Promise<unknown>) => fn(db)),
  };
  return { db, repository, calls };
}

test("TypeORM collection validates metadata primary key and builds entity schema", () => {
  expect(collection.primaryField).toBe("id");
  expect(buildSchemaFromCollections([collection])).toEqual({ todos: Todo });
  expect(() =>
    defineTypeormCollection({ name: "bad", entity: Todo, primaryField: "title" } as never),
  ).toThrow("Primary field mismatch");
  class NoPrimary {
    value!: string;
  }
  expect(() =>
    defineTypeormCollection({ name: "none", entity: NoPrimary, primaryField: "value" } as never),
  ).toThrow("Primary field not found");
});

test("TypeORM adapter runs CRUD, returns rows, handles optional absence, and runs transactions", async () => {
  const { db, repository, calls } = makeDb();
  const adapter = createTypeOrmDBAdapter({ db, collections: [collection] } as never);
  expect(adapter.schema.todos).toBe(Todo);
  expect(adapter.queryBuilder).toBe(db);
  expect(adapter.querySchema.todos).toBe(Todo);
  await adapter.insert("todos" as never, { id: 1, title: "one" } as never);
  await adapter.update("todos" as never, { id: 1, title: "two" } as never);
  await adapter.delete("todos" as never, 1 as never);
  await adapter.delete("todos" as never, { id: 1 } as never);
  expect(await adapter.get("todos" as never, 1 as never)).toEqual({ id: 1, title: "one" });
  expect(await adapter.getOptional!("todos" as never, 1 as never)).toEqual({ id: 1, title: "one" });
  expect(await adapter.getMany("todos" as never)).toHaveLength(1);
  await adapter.transaction(async (tx) => tx.insert("todos" as never, { id: 2 } as never));
  expect(repository.save).toHaveBeenCalledTimes(3);
  expect(calls).toContainEqual(["delete", { id: 1 }]);
  expect(db.transaction).toHaveBeenCalledOnce();
});

test("TypeORM commitLocalMutation uses transaction-scoped repository operations", async () => {
  const { db, repository, calls } = makeDb();
  const adapter = createTypeOrmDBAdapter({ db, collections: [collection] } as never);
  const callbackOrder: string[] = [];
  let transactionContext: any;

  await adapter.commitLocalMutation!({
    mutate: async (context) => {
      transactionContext = context;
      callbackOrder.push("mutate");
      const { operations } = context;
      await operations.insert("todos" as never, { id: 9, title: "transactional" } as never);
    },
    persistOutboxEvent: async (context) => {
      expect(context).toBe(transactionContext);
      callbackOrder.push("outbox");
    },
    persistDirtyRecord: async (context) => {
      expect(context).toBe(transactionContext);
      callbackOrder.push("dirty");
    },
  });

  expect(db.transaction).toHaveBeenCalledOnce();
  expect(transactionContext.native).toBe(db);
  expect(callbackOrder).toEqual(["mutate", "outbox", "dirty"]);
  expect(repository.save).toHaveBeenCalledWith({ id: 9, title: "transactional" });
  expect(calls).toContainEqual(["save", { id: 9, title: "transactional" }]);
});

test("TypeORM local-change writes use the transaction manager", async () => {
  const rootSave = vi.fn();
  const rootUpsert = vi.fn();
  const transactionSave = vi.fn();
  const transactionUpsert = vi.fn();
  const db = {
    manager: {
      getRepository: vi.fn(() => ({ save: rootSave, upsert: rootUpsert })),
    },
  };
  const transactionManager = {
    getRepository: vi.fn(() => ({ save: transactionSave, upsert: transactionUpsert })),
  };
  const store = createTypeOrmLocalChangeStore({
    db,
    eventEntity: OutboxEvent,
    dirtyRecordEntity: DirtyRecordEntity,
  } as never);
  await store.appendEvents(
    [
      {
        id: "event",
        type: "create",
        collection: "todos",
        data: null,
        recordId: "1",
        createdAt: 1,
      },
    ],
    transactionManager as never,
  );
  await store.upsertDirtyRecord(
    { collection: "todos", recordId: "1", state: "dirty", updatedAt: 1 },
    transactionManager as never,
  );

  expect(store.atomicLocalMutationCapability).toBe("atomic");
  expect(transactionSave).toHaveBeenCalledOnce();
  expect(transactionUpsert).toHaveBeenCalledWith(
    { collection: "todos", recordId: "1", state: "dirty", updatedAt: 1 },
    ["collection", "recordId"],
  );
  expect(rootSave).not.toHaveBeenCalled();
  expect(rootUpsert).not.toHaveBeenCalled();

  const storage = createTypeOrmStorage({
    db: db as never,
    collections: [collection],
    eventEntity: OutboxEvent,
    dirtyRecordEntity: DirtyRecordEntity,
  });
  expect(storage.localChangeStore.atomicLocalMutationCapability).toBe("atomic");
  expect(typeof storage.dbAdapter.commitLocalMutation).toBe("function");
});

test("TypeORM local-change store queries, deletes, and upserts records", async () => {
  const eventRows = [
    {
      id: "event",
      type: "create" as const,
      collection: "todos",
      data: null,
      recordId: "1",
      createdAt: 1,
    },
  ];
  const dirtyRows = [{ collection: "todos", recordId: "1", state: "dirty" as const, updatedAt: 1 }];
  const eventRepository = {
    save: vi.fn(),
    delete: vi.fn(),
    find: vi.fn(async () => eventRows),
  };
  const dirtyRepository = {
    upsert: vi.fn(),
    delete: vi.fn(),
    find: vi.fn(async () => dirtyRows),
  };
  const manager = {
    getRepository: vi.fn((entity: unknown) =>
      entity === OutboxEvent ? eventRepository : dirtyRepository,
    ),
  };
  const store = createTypeOrmLocalChangeStore({
    db: { manager },
    eventEntity: OutboxEvent,
    dirtyRecordEntity: DirtyRecordEntity,
  } as never);

  await store.appendEvents([]);
  await store.deleteEvents([]);
  await store.removeDirtyRecords([]);
  await expect(store.getPendingEvents("todos")).resolves.toEqual(eventRows);
  await expect(store.getPendingEvents()).resolves.toEqual(eventRows);
  await store.deleteEvents(["event", "other"]);
  const record = { collection: "todos", recordId: "1", state: "dirty" as const, updatedAt: 1 };
  await store.upsertDirtyRecord(record);
  await expect(store.getDirtyRecords("todos")).resolves.toEqual(dirtyRows);
  await expect(store.getDirtyRecords()).resolves.toEqual(dirtyRows);
  await store.removeDirtyRecords([{ collection: "todos", recordId: "1" }]);

  expect(eventRepository.find).toHaveBeenNthCalledWith(1, {
    where: { collection: "todos" },
    order: { createdAt: "ASC" },
  });
  expect(eventRepository.find).toHaveBeenNthCalledWith(2, {
    order: { createdAt: "ASC" },
  });
  expect(eventRepository.delete).toHaveBeenNthCalledWith(1, { id: "event" });
  expect(eventRepository.delete).toHaveBeenNthCalledWith(2, { id: "other" });
  expect(dirtyRepository.upsert).toHaveBeenCalledWith(record, ["collection", "recordId"]);
  expect(dirtyRepository.find).toHaveBeenNthCalledWith(1, { where: { collection: "todos" } });
  expect(dirtyRepository.find).toHaveBeenNthCalledWith(2, {});
  expect(dirtyRepository.delete).toHaveBeenCalledWith({ collection: "todos", recordId: "1" });
});

test("TypeORM local-change entities reject incomplete schemas at type level", () => {
  const invalidEventEntity = class {};
  const db = {} as never;

  createTypeOrmLocalChangeStore({
    db,
    // @ts-expect-error event entity omits persisted event fields
    eventEntity: invalidEventEntity,
    dirtyRecordEntity: DirtyRecordEntity,
  });

  class TextPayloadEvent {
    id!: string;
    type!: "create" | "update" | "delete";
    collection!: string;
    data!: string;
    recordId!: string;
    createdAt!: number;
  }
  // @ts-expect-error event data must accept all local event payloads
  createTypeOrmLocalChangeStore({
    db,
    eventEntity: TextPayloadEvent,
    dirtyRecordEntity: DirtyRecordEntity,
  });
});

test("TypeORM adapter propagates repository failures and maps null optional reads", async () => {
  const { db, repository } = makeDb(null);
  const adapter = createTypeOrmDBAdapter({ db, collections: [collection] } as never);
  await expect(adapter.getOptional!("todos" as never, 1 as never)).resolves.toBeUndefined();
  await expect(adapter.get("todos" as never, 1 as never)).rejects.toThrow("missing");
  repository.save.mockRejectedValueOnce(new Error("write failed"));
  await expect(adapter.insert("todos" as never, { id: 2 } as never)).rejects.toThrow(
    "write failed",
  );
  await expect(adapter.delete("unknown" as never, 1 as never)).rejects.toThrow(
    "Unknown collection: unknown",
  );
});

test("TypeORM adapter accepts an explicit schema", () => {
  const { db } = makeDb();
  const schema = { todos: Todo };
  const adapter = createTypeOrmDBAdapter({ db, collections: [collection], schema } as never);
  expect(adapter.schema).toBe(schema);
});
