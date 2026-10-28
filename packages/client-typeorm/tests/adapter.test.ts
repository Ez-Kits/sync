import "reflect-metadata";
import { expect, test, vi } from "vite-plus/test";
import { PrimaryColumn } from "typeorm";
import { buildSchemaFromCollections, defineTypeormCollection } from "../src/collection";
import { createTypeOrmProxyDBAdapter } from "../src/core/create-typeorm-proxy-db-adapter";
import { createTypeOrmLocalChangeStore } from "../src/core/local-change-store";
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
/** Stand-ins for the dialect's outbox entities; only their identity matters here. */
const entities = { events: OutboxEvent, dirtyRecords: DirtyRecordEntity } as never;

/** An adapter whose driver hands back the mock data source. */
function adapterFor(db: unknown, createDataSource = vi.fn(() => db as never)) {
  return createTypeOrmProxyDBAdapter(
    { dbStorage: { dialect: "sqlite" } as never, collections: [collection] },
    { dialect: "sqlite", createDataSource, localChangeEntities: entities },
  );
}

function makeDb(row: unknown = { id: 1, title: "one" }) {
  const calls: unknown[][] = [];
  const execute = vi.fn(async () => ({}));
  const write: unknown[] = [];
  const builder = {
    insert: () => builder,
    into: () => builder,
    values: (values: unknown) => (write.push("insert", values), builder),
    update: () => builder,
    set: (values: unknown) => (write.push("update", values), builder),
    where: (where: unknown) => (write.push(where), builder),
    updateEntity: () => builder,
    execute: async () => {
      calls.push(write.splice(0));
      return execute();
    },
  };
  const repository = {
    createQueryBuilder: () => builder,
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
    options: { type: "sqljs" },
    getRepository: vi.fn(() => repository),
    transaction: vi.fn(async (fn: (manager: any) => Promise<unknown>) => fn(db)),
  };
  return { db, repository, execute, calls };
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
  const { db, calls } = makeDb();
  const adapter = adapterFor(db);
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
  await expect(adapter.update("todos" as never, { title: "no id" } as never)).rejects.toThrow(
    'Update requires primary field "id"',
  );
  expect(calls).toContainEqual(["insert", { id: 1, title: "one" }]);
  expect(calls).toContainEqual(["update", { id: 1, title: "two" }, { id: 1 }]);
  expect(calls).toContainEqual(["insert", { id: 2 }]);
  expect(calls).toContainEqual(["delete", { id: 1 }]);
  expect(db.transaction).toHaveBeenCalledOnce();
});

test("TypeORM commitLocalMutation uses transaction-scoped repository operations", async () => {
  const { db, calls } = makeDb();
  const adapter = adapterFor(db);
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
  expect(calls).toContainEqual(["insert", { id: 9, title: "transactional" }]);
});

test("TypeORM local-change writes use the transaction manager", async () => {
  const rootInsert = vi.fn();
  const rootUpsert = vi.fn();
  const transactionInsert = vi.fn();
  const transactionUpsert = vi.fn();
  const db = {
    options: { type: "sqljs" },
    manager: {
      getRepository: vi.fn(() => ({ insert: rootInsert, upsert: rootUpsert })),
    },
  };
  const transactionManager = {
    getRepository: vi.fn(() => ({ insert: transactionInsert, upsert: transactionUpsert })),
  };
  const store = createTypeOrmLocalChangeStore(db as never, entities);
  const event = {
    id: "event",
    type: "create" as const,
    collection: "todos",
    data: null,
    recordId: "1",
    createdAt: 1,
  };
  // A `seq` read back with an event never reaches the insert: the database assigns it.
  await store.appendEvents([{ ...event, seq: 7 } as typeof event], transactionManager as never);
  expect(transactionInsert).toHaveBeenCalledWith([event]);
  await store.upsertDirtyRecord(
    { collection: "todos", recordId: "1", state: "dirty", updatedAt: 1 },
    transactionManager as never,
  );

  expect(store.atomicLocalMutationCapability).toBe("atomic");
  expect(transactionInsert).toHaveBeenCalledOnce();
  expect(transactionUpsert).toHaveBeenCalledWith(
    { collection: "todos", recordId: "1", state: "dirty", updatedAt: 1 },
    ["collection", "recordId"],
  );
  expect(rootInsert).not.toHaveBeenCalled();
  expect(rootUpsert).not.toHaveBeenCalled();

  const adapter = adapterFor(db);
  expect(adapter.localChangeStore.atomicLocalMutationCapability).toBe("atomic");
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
    insert: vi.fn(),
    delete: vi.fn(),
    find: vi.fn(async () => eventRows),
  };
  const dirtyRepository = {
    upsert: vi.fn(),
    delete: vi.fn(),
    find: vi.fn(async () => dirtyRows),
  };
  const repositories = () => ({
    getRepository: vi.fn((entity: unknown) =>
      entity === OutboxEvent ? eventRepository : dirtyRepository,
    ),
  });
  const manager = repositories();
  const store = createTypeOrmLocalChangeStore({ manager } as never, entities);

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

  // Pending events sort by the database-assigned `seq`, which is never read back.
  const select = ["id", "type", "collection", "data", "recordId", "createdAt"];
  expect(eventRepository.find).toHaveBeenNthCalledWith(1, {
    where: { collection: "todos" },
    select,
    order: { seq: "ASC" },
  });
  expect(eventRepository.find).toHaveBeenNthCalledWith(2, { select, order: { seq: "ASC" } });
  expect(eventRepository.delete).toHaveBeenNthCalledWith(1, { id: "event" });
  expect(eventRepository.delete).toHaveBeenNthCalledWith(2, { id: "other" });
  expect(dirtyRepository.upsert).toHaveBeenCalledWith(record, ["collection", "recordId"]);
  expect(dirtyRepository.find).toHaveBeenNthCalledWith(1, { where: { collection: "todos" } });
  expect(dirtyRepository.find).toHaveBeenNthCalledWith(2, {});
  expect(dirtyRepository.delete).toHaveBeenCalledWith({ collection: "todos", recordId: "1" });

  // Every method, reads included, runs on a transaction manager it is given.
  const transaction = repositories();
  const key = { collection: "todos", recordId: "1" };
  await store.getPendingEvents(key, transaction as never);
  await store.getDirtyRecords(key, transaction as never);
  await store.deleteEvents(["event"], transaction as never);
  await store.removeDirtyRecords([key], transaction as never);
  expect(eventRepository.find).toHaveBeenLastCalledWith({
    where: key,
    select,
    order: { seq: "ASC" },
  });
  expect(dirtyRepository.find).toHaveBeenLastCalledWith({ where: key });
  expect(transaction.getRepository).toHaveBeenCalledTimes(4);
  expect(manager.getRepository).toHaveBeenCalledTimes(9);
});

test("TypeORM adapter propagates repository failures and maps null optional reads", async () => {
  const { db, execute } = makeDb(null);
  const adapter = adapterFor(db);
  await expect(adapter.getOptional!("todos" as never, 1 as never)).resolves.toBeUndefined();
  await expect(adapter.get("todos" as never, 1 as never)).rejects.toThrow("missing");
  execute.mockRejectedValueOnce(new Error("write failed"));
  await expect(adapter.insert("todos" as never, { id: 2 } as never)).rejects.toThrow(
    "write failed",
  );
  await expect(adapter.delete("unknown" as never, 1 as never)).rejects.toThrow(
    "Unknown collection: unknown",
  );
});

test("the driver builds the data source from every entity and exposes typed repositories", () => {
  const { db, repository } = makeDb();
  const createDataSource = vi.fn(() => db as never);
  const adapter = adapterFor(db, createDataSource);
  expect(createDataSource).toHaveBeenCalledWith(
    { dialect: "sqlite" },
    [Todo, OutboxEvent, DirtyRecordEntity],
    undefined,
  );
  expect((adapter.db.repositories as any).todos).toBe(repository);
  expect(Object.keys(adapter.db.repositories)).toEqual(["todos"]);

  createDataSource.mockReturnValue(makeDb().db as never);
  createTypeOrmProxyDBAdapter(
    {
      dbStorage: { dialect: "sqlite" } as never,
      collections: [collection],
      entities: [DirtyRecordEntity],
      dataSourceOptions: { logging: true },
    },
    { dialect: "sqlite", createDataSource, localChangeEntities: entities },
  );
  expect(createDataSource).toHaveBeenLastCalledWith(
    { dialect: "sqlite" },
    [Todo, DirtyRecordEntity, OutboxEvent, DirtyRecordEntity],
    { logging: true },
  );
});

test("the adapter rejects a storage of another dialect", () => {
  expect(() =>
    createTypeOrmProxyDBAdapter(
      { dbStorage: { dialect: "postgres" } as never, collections: [collection] },
      { dialect: "sqlite", createDataSource: vi.fn(), localChangeEntities: entities },
    ),
  ).toThrow("built for sqlite but the storage speaks postgres");
});
