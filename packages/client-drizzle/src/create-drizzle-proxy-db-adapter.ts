import {
  primaryFields,
  primaryKeyEntries,
  primaryKeyOf,
  type AtomicLocalChangeStore,
  type CollectionConfigMap,
  type CollectionNames,
  type ConfigForName,
  type DBAdapterOperations,
  type DBAdapterTransactionContext,
  type DBDialect,
  type DBExecutor,
  type DBStorage,
  type InferCollectionInsertModel,
  type InferCollectionPrimaryFieldType,
  type InferCollectionSelectModel,
  type InferCollectionUpdateModel,
} from "@ez-kits/sync-client-core";
import {
  and,
  eq,
  getColumns,
  type AnyRelations,
  type Column,
  type SQL,
  type Table,
} from "drizzle-orm";
import {
  buildRelationsFromCollections,
  buildSchemaFromCollections,
  type BuildRelationsFromCollections,
  type BuildSchemaFromCollections,
} from "./collection";
import type { DrizzleDBAdapter } from "./types";

/** Options shared by the dialect adapters (`createDrizzleSqliteDBAdapter`, `createDrizzlePgDBAdapter`). */
export type DrizzleProxyDBAdapterConfig<
  C extends CollectionConfigMap,
  TRelations extends AnyRelations = BuildRelationsFromCollections<C>,
  TDrizzleConfig = unknown,
> = {
  /** Where every statement runs, in this context or forwarded to the leader. */
  readonly dbStorage: DBStorage;
  readonly collections: C;
  /**
   * Relational config for `db.query`, from `defineRelations`. Defaults to every collection
   * table without relations (`buildRelationsFromCollections`).
   */
  readonly relations?: TRelations;
  /** Extra Drizzle options (logger, casing, codecs, ...). `relations` is set separately. */
  readonly drizzleOptions?: TDrizzleConfig;
};

/** What a dialect entry point supplies to {@link createDrizzleProxyDBAdapter}. */
export interface DrizzleProxyDriver<TDatabase, TRelations extends AnyRelations> {
  readonly dialect: DBDialect;
  /**
   * A Drizzle proxy database running on `executor`: the storage itself, or one of its
   * transactions. Called once per transaction, so it must stay cheap.
   */
  createDatabase(executor: DBExecutor, relations: TRelations): TDatabase;
  /**
   * The outbox store, in the dialect's predefined local-change tables. Its `initialize`
   * creates those tables through `dbStorage`, so applications never migrate them.
   */
  createLocalChangeStore(db: TDatabase, dbStorage: DBStorage): AtomicLocalChangeStore;
}

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

function primaryCondition(table: Table, config: CollectionConfigMap[number], id: unknown): SQL {
  const conditions = primaryKeyEntries(config, id).map(([field, value]) =>
    eq(getTableColumn(table, field), value),
  );
  return and(...conditions)!;
}

function describeKey(id: unknown): string {
  return typeof id === "object" && id !== null ? JSON.stringify(id) : String(id);
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
      const config = getCollectionConfig(collections, collection);
      const row = data as Record<string, unknown>;
      const missing = primaryFields(config).find((field) => row[field] === undefined);
      if (missing !== undefined) {
        throw new Error(`Update requires primary field "${missing}"`);
      }
      const id = primaryKeyOf(config, row);
      await queryDb
        .update(table)
        .set(data)
        .where(primaryCondition(table, config, id));
    },
    async delete<N extends CollectionNames<C>>(
      collection: N,
      id: InferCollectionPrimaryFieldType<ConfigForName<C, N>>,
    ): Promise<void> {
      const table = resolvedSchema[collection] as Table;
      const config = getCollectionConfig(collections, collection);
      await queryDb.delete(table).where(primaryCondition(table, config, id));
    },
    async get<N extends CollectionNames<C>>(
      collection: N,
      id: InferCollectionPrimaryFieldType<ConfigForName<C, N>>,
    ): Promise<InferCollectionSelectModel<ConfigForName<C, N>>> {
      const table = resolvedSchema[collection] as Table;
      const config = getCollectionConfig(collections, collection);
      const rows = (await queryDb
        .select()
        .from(table)
        .where(primaryCondition(table, config, id))) as InferCollectionSelectModel<
        ConfigForName<C, N>
      >[];
      const row = rows[0];
      if (!row) {
        throw new Error(`Row not found in "${String(collection)}" for id ${describeKey(id)}`);
      }
      return row;
    },
    async getOptional<N extends CollectionNames<C>>(
      collection: N,
      id: InferCollectionPrimaryFieldType<ConfigForName<C, N>>,
    ): Promise<InferCollectionSelectModel<ConfigForName<C, N>> | undefined> {
      const table = resolvedSchema[collection] as Table;
      const config = getCollectionConfig(collections, collection);
      const rows = (await queryDb
        .select()
        .from(table)
        .where(primaryCondition(table, config, id))) as InferCollectionSelectModel<
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

/**
 * The dialect-independent part of the Drizzle adapters. Queries run on the storage through
 * the driver's proxy database; transactions get a database bound to one storage
 * transaction, so a follower's transaction runs isolated on the leader.
 */
export function createDrizzleProxyDBAdapter<
  C extends CollectionConfigMap,
  TRelations extends AnyRelations,
  TDatabase,
>(
  config: DrizzleProxyDBAdapterConfig<C, TRelations, unknown>,
  driver: DrizzleProxyDriver<TDatabase, TRelations>,
): DrizzleDBAdapter<C, TDatabase, BuildSchemaFromCollections<C>> {
  const { dbStorage, collections } = config;
  if (dbStorage.dialect !== driver.dialect) {
    throw new Error(
      `The Drizzle adapter is built for ${driver.dialect} but the storage speaks ${dbStorage.dialect}.`,
    );
  }
  const schema = buildSchemaFromCollections(collections);
  const relations =
    config.relations ?? (buildRelationsFromCollections(collections) as unknown as TRelations);
  const drizzleFor = (executor: DBExecutor) => driver.createDatabase(executor, relations);
  const db = drizzleFor(dbStorage);
  const operationsFor = (queryDb: unknown) =>
    createOperations(queryDb as DrizzleQueryDb, schema, collections);
  const inTransaction = <T>(fn: (context: DBAdapterTransactionContext<C>) => Promise<T>) =>
    dbStorage.transaction((tx) => {
      const txDb = drizzleFor(tx);
      return fn({ operations: operationsFor(txDb), native: txDb });
    });

  return {
    db,
    schema,
    queryBuilder: db,
    querySchema: schema,
    dbStorage,
    localChangeStore: driver.createLocalChangeStore(db, dbStorage),
    ...operationsFor(db),
    transaction<T>(
      fn: (tx: DBAdapterOperations<C>, context: DBAdapterTransactionContext<C>) => Promise<T>,
    ): Promise<T> {
      return inTransaction((context) => fn(context.operations, context));
    },
    commitLocalMutation({ mutate, persistOutboxEvent }) {
      return inTransaction(async (context) => {
        await mutate(context);
        await persistOutboxEvent(context);
      });
    },
  };
}
