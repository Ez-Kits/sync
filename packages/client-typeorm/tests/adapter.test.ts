import "reflect-metadata";
import { expect, test, vi } from "vite-plus/test";
import { PrimaryColumn } from "typeorm";
import { buildSchemaFromCollections, defineTypeormCollection } from "../src/collection";
import { createTypeOrmDBAdapter } from "../src/create-typeorm-db-adapter";

class Todo {
  id!: number;
  title!: string;
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
