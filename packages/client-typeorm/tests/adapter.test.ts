import "reflect-metadata";
import { expect, test, vi } from "vite-plus/test";
import { PrimaryColumn } from "typeorm";
import { buildSchemaFromCollections, defineTypeOrmCollection } from "../src/collection";
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

class AppliedEventEntity {
  eventId!: string;
  appliedAt!: number;
}
PrimaryColumn("integer")(Todo.prototype, "id");
const collection = defineTypeOrmCollection({ name: "todos", entity: Todo, primaryField: "id" });
/** Stand-ins for the dialect's outbox entities; only their identity matters here. */
const entities = {
  events: OutboxEvent,
  dirtyRecords: DirtyRecordEntity,
  appliedEvents: AppliedEventEntity,
} as never;

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
    initialize: vi.fn(async () => db),
    destroy: vi.fn(async () => {}),
    getRepository: vi.fn(() => repository),
    transaction: vi.fn(async (fn: (manager: any) => Promise<unknown>) => fn(db)),
  };
  return { db, repository, execute, calls };
}

test("TypeORM collection validates metadata primary key and builds entity schema", () => {
  expect(collection.primaryField).toBe("id");
  expect(buildSchemaFromCollections([collection])).toEqual({ todos: Todo });
  expect(() =>
    defineTypeOrmCollection({ name: "bad", entity: Todo, primaryField: "title" } as never),
  ).toThrow("Primary field mismatch");
  class NoPrimary {
    value!: string;
  }
  expect(() =>
    defineTypeOrmCollection({ name: "none", entity: NoPrimary, primaryField: "value" } as never),
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
  await expect(adapter.delete("todos" as never, { id: 1 } as never)).rejects.toThrow(
    "Composite primary keys are not supported",
  );
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

test("TypeORM adapter runs transactions on a data source of their own, retrying a failed open", async () => {
  const main = makeDb();
  const own = makeDb();
  const adapter = adapterFor(
    main.db,
    vi
      .fn((): never => main.db as never)
      .mockReturnValueOnce(main.db as never)
      .mockReturnValueOnce(own.db as never),
  );
  own.db.initialize.mockRejectedValueOnce(new Error("cannot open"));
  const insert = () => adapter.transaction((tx) => tx.insert("todos" as never, { id: 2 } as never));
  await expect(insert()).rejects.toThrow("cannot open");
  await insert();
  await insert();
  expect(own.db.initialize).toHaveBeenCalledTimes(2);
  expect(own.db.transaction).toHaveBeenCalledTimes(2);
  expect(main.db.transaction).not.toHaveBeenCalled();
  expect(main.db.initialize).not.toHaveBeenCalled();
});

test("closing the adapter waits for its transaction and destroys an opened data source", async () => {
  const main = makeDb();
  const own = makeDb();
  const destroyMain = main.db.destroy;
  const adapter = adapterFor(
    main.db,
    vi
      .fn((): never => main.db as never)
      .mockReturnValueOnce(main.db as never)
      .mockReturnValueOnce(own.db as never),
  );

  // Never opened: nothing to destroy.
  await adapter.close!();
  expect(destroyMain).not.toHaveBeenCalled();

  Object.assign(main.db, { isInitialized: true });
  let finish!: () => void;
  const running = adapter.transaction(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await vi.waitFor(() => expect(finish).toBeDefined());
  const closing = adapter.close!();
  await Promise.resolve();
  expect(destroyMain).not.toHaveBeenCalled();
  finish();
  await running;
  await closing;
  expect(destroyMain).toHaveBeenCalledOnce();
  expect(own.db.destroy).toHaveBeenCalledOnce();
});

test("destroying the data source also closes the transaction data source, if it opened", async () => {
  const main = makeDb();
  const own = makeDb();
  const destroyMain = main.db.destroy;
  const adapter = adapterFor(
    main.db,
    vi
      .fn((): never => main.db as never)
      .mockReturnValueOnce(main.db as never)
      .mockReturnValueOnce(own.db as never),
  );
  const insert = () => adapter.transaction((tx) => tx.insert("todos" as never, { id: 2 } as never));

  // Never opened.
  await adapter.db.destroy();
  expect(destroyMain).toHaveBeenCalledTimes(1);
  expect(own.db.destroy).not.toHaveBeenCalled();

  // Opened, then reopened by the next transaction.
  await insert();
  await adapter.db.destroy();
  expect(own.db.destroy).toHaveBeenCalledTimes(1);
  await insert();
  expect(own.db.initialize).toHaveBeenCalledTimes(2);

  // Destroyed while opening fails: there is nothing to close.
  await adapter.db.destroy();
  let failOpen!: (error: Error) => void;
  own.db.initialize.mockImplementationOnce(
    () => new Promise((_, reject) => (failOpen = reject)) as never,
  );
  const failed = insert();
  await new Promise((resolve) => setTimeout(resolve));
  const destroyed = adapter.db.destroy();
  failOpen(new Error("cannot open"));
  await destroyed;
  await expect(failed).rejects.toThrow("cannot open");
  expect(own.db.destroy).toHaveBeenCalledTimes(2);
  expect(destroyMain).toHaveBeenCalledTimes(4);
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
    destroy: vi.fn(),
    manager: {
      getRepository: vi.fn(() => ({ insert: rootInsert, upsert: rootUpsert })),
    },
  };
  const transactionDelete = vi.fn();
  const transactionManager = {
    getRepository: vi.fn(() => ({
      insert: transactionInsert,
      upsert: transactionUpsert,
      delete: transactionDelete,
    })),
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
  // The applied record is pruned and written in the same transaction.
  expect(transactionDelete).toHaveBeenCalledOnce();
  expect(transactionInsert).toHaveBeenLastCalledWith([{ eventId: "event", appliedAt: 1 }]);
  await store.upsertDirtyRecord(
    { collection: "todos", recordId: "1", state: "dirty", updatedAt: 1 },
    transactionManager as never,
  );

  expect(store.atomicLocalMutationCapability).toBe("atomic");
  expect(transactionInsert).toHaveBeenCalledTimes(2);
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
    [Todo, OutboxEvent, DirtyRecordEntity, AppliedEventEntity],
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
    [Todo, DirtyRecordEntity, OutboxEvent, DirtyRecordEntity, AppliedEventEntity],
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
