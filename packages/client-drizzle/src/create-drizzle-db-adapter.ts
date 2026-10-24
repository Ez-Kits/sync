import type {
  CollectionConfigMap,
  CollectionNames,
  ConfigForName,
  DBAdapterOperations,
  InferCollectionInsertModel,
  InferCollectionPrimaryFieldType,
  InferCollectionSelectModel,
  InferCollectionUpdateModel,
} from "@ez-kits/sync-client-core";
import { and, eq, getColumns, type Column, type SQL, type Table } from "drizzle-orm";
import { buildSchemaFromCollections, type BuildSchemaFromCollections } from "./collection";
import type { DrizzleDBAdapter } from "./types";

export type DrizzleDBAdapterConfig<
  C extends CollectionConfigMap,
  TDrizzleDB,
  TTables extends Record<CollectionNames<C>, unknown> = BuildSchemaFromCollections<C>,
> = {
  readonly db: TDrizzleDB;
  readonly schema?: TTables;
  readonly collections: C;
};

/** Minimal drizzle database surface used by CRUD helpers across dialects. */
type DrizzleQueryDb = {
  insert: (table: Table) => { values: (values: unknown) => unknown };
  update: (table: Table) => {
    set: (values: unknown) => {
      where: (condition: SQL | undefined) => unknown;
    };
  };
  delete: (table: Table) => {
    where: (condition: SQL | undefined) => unknown;
  };
  select: () => {
    from: (table: Table) => PromiseLike<unknown[]> & {
      where: (condition: SQL | undefined) => PromiseLike<unknown[]>;
    };
  };
};

type DrizzleTransactionalDb = DrizzleQueryDb & {
  transaction: <T>(fn: (tx: DrizzleQueryDb) => Promise<T>) => Promise<T>;
};

function getCollectionConfig<C extends CollectionConfigMap, N extends CollectionNames<C>>(
  collections: C,
  name: N,
): ConfigForName<C, N> {
  const found = collections.find((c) => c.name === name);
  if (!found) {
    throw new Error(`Unknown collection: ${String(name)}`);
  }
  return found as ConfigForName<C, N>;
}

function getTableColumn(table: Table, field: PropertyKey): Column {
  const columns = getColumns(table);
  const column = columns[String(field)];
  if (!column) {
    throw new Error(`Unknown column: ${String(field)}`);
  }
  return column;
}

function primaryCondition(table: Table, primaryField: PropertyKey, id: unknown): SQL {
  if (typeof id === "object" && id !== null && !Array.isArray(id)) {
    const conditions = Object.entries(id as Record<string, unknown>).map(([key, value]) =>
      eq(getTableColumn(table, key), value),
    );
    const combined = and(...conditions);
    if (!combined) {
      throw new Error("Composite primary key must not be empty");
    }
    return combined;
  }
  return eq(getTableColumn(table, primaryField), id);
}

function createOperations<
  C extends CollectionConfigMap,
  TTables extends Record<CollectionNames<C>, unknown>,
>(queryDb: DrizzleQueryDb, resolvedSchema: TTables, collections: C): DBAdapterOperations<C> {
  return {
    async insert<N extends CollectionNames<C>>(
      collection: N,
      data: InferCollectionInsertModel<ConfigForName<C, N>>,
    ): Promise<void> {
      const table = resolvedSchema[collection] as Table;
      await queryDb.insert(table).values(data);
    },
    async update<N extends CollectionNames<C>>(
      collection: N,
      data: InferCollectionUpdateModel<ConfigForName<C, N>>,
    ): Promise<void> {
      const table = resolvedSchema[collection] as Table;
      const primaryField = getCollectionConfig(collections, collection).primaryField;
      const row = data as Record<string, unknown>;
      const id = row[String(primaryField)];
      if (id === undefined) {
        throw new Error(`Update requires primary field "${String(primaryField)}"`);
      }
      await queryDb
        .update(table)
        .set(data)
        .where(primaryCondition(table, primaryField, id));
    },
    async delete<N extends CollectionNames<C>>(
      collection: N,
      id: InferCollectionPrimaryFieldType<ConfigForName<C, N>>,
    ): Promise<void> {
      const table = resolvedSchema[collection] as Table;
      const primaryField = getCollectionConfig(collections, collection).primaryField;
      await queryDb.delete(table).where(primaryCondition(table, primaryField, id));
    },
    async get<N extends CollectionNames<C>>(
      collection: N,
      id: InferCollectionPrimaryFieldType<ConfigForName<C, N>>,
    ): Promise<InferCollectionSelectModel<ConfigForName<C, N>>> {
      const table = resolvedSchema[collection] as Table;
      const primaryField = getCollectionConfig(collections, collection).primaryField;
      const rows = (await queryDb
        .select()
        .from(table)
        .where(primaryCondition(table, primaryField, id))) as InferCollectionSelectModel<
        ConfigForName<C, N>
      >[];
      const row = rows[0];
      if (!row) {
        throw new Error(`Row not found in "${String(collection)}" for id ${String(id)}`);
      }
      return row;
    },
    async getOptional<N extends CollectionNames<C>>(
      collection: N,
      id: InferCollectionPrimaryFieldType<ConfigForName<C, N>>,
    ): Promise<InferCollectionSelectModel<ConfigForName<C, N>> | undefined> {
      const table = resolvedSchema[collection] as Table;
      const primaryField = getCollectionConfig(collections, collection).primaryField;
      const rows = (await queryDb
        .select()
        .from(table)
        .where(primaryCondition(table, primaryField, id))) as InferCollectionSelectModel<
        ConfigForName<C, N>
      >[];
      return rows[0];
    },
    async getMany<N extends CollectionNames<C>>(
      collection: N,
    ): Promise<InferCollectionSelectModel<ConfigForName<C, N>>[]> {
      const table = resolvedSchema[collection] as Table;
      const rows = (await queryDb.select().from(table)) as InferCollectionSelectModel<
        ConfigForName<C, N>
      >[];
      return rows;
    },
  };
}

export function createDrizzleDBAdapter<
  C extends CollectionConfigMap,
  TDrizzleDB,
  TTables extends Record<CollectionNames<C>, unknown> = BuildSchemaFromCollections<C>,
>(
  adapter: DrizzleDBAdapterConfig<C, TDrizzleDB, TTables>,
): DrizzleDBAdapter<C, TDrizzleDB, TTables> {
  const { db, collections } = adapter;
  let schema: TTables | undefined = adapter.schema;

  if (!schema) {
    schema = buildSchemaFromCollections(collections) as TTables;
  }

  const resolvedSchema = schema;
  const drizzleDb = db as DrizzleTransactionalDb;
  const operations = createOperations(drizzleDb, resolvedSchema, collections);

  return {
    db,
    schema: resolvedSchema,
    queryBuilder: db,
    querySchema: resolvedSchema,
    ...operations,
    async transaction<T>(fn: (tx: DBAdapterOperations<C>) => Promise<T>): Promise<T> {
      return drizzleDb.transaction((tx) => fn(createOperations(tx, resolvedSchema, collections)));
    },
  };
}
