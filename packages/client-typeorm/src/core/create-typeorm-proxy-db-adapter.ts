import type {
  CollectionConfigMap,
  CollectionNames,
  ConfigForName,
  DBAdapterOperations,
  DBAdapterTransactionContext,
  DBDialect,
  DBStorage,
  InferCollectionInsertModel,
  InferCollectionPrimaryFieldType,
  InferCollectionSelectModel,
  InferCollectionUpdateModel,
} from "@ez-kits/sync-client-core";
import type { DataSource, EntityManager, EntitySchema, EntityTarget, ObjectLiteral } from "typeorm";
import { buildSchemaFromCollections, type BuildSchemaFromCollections } from "../collection";
import type { TypeOrmDatabase, TypeOrmDBAdapter } from "../types";
import {
  createTypeOrmLocalChangeStore,
  type TypeOrmLocalChangeEntities,
} from "./local-change-store";

/** An entity a data source can register: a decorated class or an `EntitySchema`. */
// eslint-disable-next-line typescript/no-unsafe-function-type -- TypeORM's own entity type.
export type TypeOrmEntity = Function | EntitySchema<any>;

/** Options shared by the dialect adapters (`createTypeOrmSqliteDBAdapter`, `createTypeOrmPgDBAdapter`). */
export type TypeOrmProxyDBAdapterConfig<
  C extends CollectionConfigMap,
  TDataSourceOptions = unknown,
> = {
  /** Where every statement runs, in this context or forwarded to the leader. */
  readonly dbStorage: DBStorage;
  readonly collections: C;
  /** Other entities the data source should know, e.g. targets of relations. */
  readonly entities?: readonly TypeOrmEntity[];
  /** Extra data source options (logging, naming strategy, ...). */
  readonly dataSourceOptions?: TDataSourceOptions;
};

/** What a dialect entry point supplies to {@link createTypeOrmProxyDBAdapter}. */
export interface TypeOrmProxyDriver<TDataSourceOptions> {
  readonly dialect: DBDialect;
  /** The data source, with a driver that runs every statement on `dbStorage`. */
  createDataSource(
    dbStorage: DBStorage,
    entities: TypeOrmEntity[],
    dataSourceOptions: TDataSourceOptions | undefined,
  ): DataSource;
  /** The dialect's outbox entities; the adapter registers and creates them itself. */
  readonly localChangeEntities: TypeOrmLocalChangeEntities;
}

function primaryWhere(primaryField: PropertyKey, id: unknown): ObjectLiteral {
  if (typeof id === "object" && id !== null && !Array.isArray(id)) {
    return id as ObjectLiteral;
  }
  return { [String(primaryField)]: id } as ObjectLiteral;
}

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

type TypeOrmQuerySource = Pick<DataSource, "getRepository"> | EntityManager;

function createOperations<
  C extends CollectionConfigMap,
  TSchema extends Record<CollectionNames<C>, unknown>,
>(source: TypeOrmQuerySource, resolvedSchema: TSchema, collections: C): DBAdapterOperations<C> {
  return {
    // One statement per write, like the other adapters: `save` would select the row first
    // and reload defaults after, and the sync engine already knows which write it needs.
    async insert<N extends CollectionNames<C>>(
      collection: N,
      data: InferCollectionInsertModel<ConfigForName<C, N>>,
    ): Promise<void> {
      const entity = resolvedSchema[collection] as EntityTarget<ObjectLiteral>;
      await source
        .getRepository(entity)
        .createQueryBuilder()
        .insert()
        .into(entity)
        .values(data as ObjectLiteral)
        .updateEntity(false)
        .execute();
    },
    async update<N extends CollectionNames<C>>(
      collection: N,
      data: InferCollectionUpdateModel<ConfigForName<C, N>>,
    ): Promise<void> {
      const entity = resolvedSchema[collection] as EntityTarget<ObjectLiteral>;
      const primaryField = getCollectionConfig(collections, collection).primaryField;
      const id = (data as ObjectLiteral)[String(primaryField)];
      if (id === undefined) {
        throw new Error(`Update requires primary field "${String(primaryField)}"`);
      }
      await source
        .getRepository(entity)
        .createQueryBuilder()
        .update(entity)
        .set(data as ObjectLiteral)
        .where(primaryWhere(primaryField, id))
        .updateEntity(false)
        .execute();
    },
    async delete<N extends CollectionNames<C>>(
      collection: N,
      id: InferCollectionPrimaryFieldType<ConfigForName<C, N>>,
    ): Promise<void> {
      const entity = resolvedSchema[collection] as EntityTarget<ObjectLiteral>;
      const primaryField = getCollectionConfig(collections, collection).primaryField;
      await source.getRepository(entity).delete(primaryWhere(primaryField, id));
    },
    async get<N extends CollectionNames<C>>(
      collection: N,
      id: InferCollectionPrimaryFieldType<ConfigForName<C, N>>,
    ): Promise<InferCollectionSelectModel<ConfigForName<C, N>>> {
      const entity = resolvedSchema[collection] as EntityTarget<ObjectLiteral>;
      const primaryField = getCollectionConfig(collections, collection).primaryField;
      const row = await source.getRepository(entity).findOneOrFail({
        where: primaryWhere(primaryField, id),
      });
      return row as InferCollectionSelectModel<ConfigForName<C, N>>;
    },
    async getOptional<N extends CollectionNames<C>>(
      collection: N,
      id: InferCollectionPrimaryFieldType<ConfigForName<C, N>>,
    ): Promise<InferCollectionSelectModel<ConfigForName<C, N>> | undefined> {
      const entity = resolvedSchema[collection] as EntityTarget<ObjectLiteral>;
      const primaryField = getCollectionConfig(collections, collection).primaryField;
      const row = await source.getRepository(entity).findOne({
        where: primaryWhere(primaryField, id),
      });
      return row === null ? undefined : (row as InferCollectionSelectModel<ConfigForName<C, N>>);
    },
    async getMany<N extends CollectionNames<C>>(
      collection: N,
    ): Promise<InferCollectionSelectModel<ConfigForName<C, N>>[]> {
      const entity = resolvedSchema[collection] as EntityTarget<ObjectLiteral>;
      const rows = await source.getRepository(entity).find();
      return rows as InferCollectionSelectModel<ConfigForName<C, N>>[];
    },
  };
}

/** The data source, with a typed repository per collection. */
function createTypeOrmDatabase<TSchema extends Record<string, unknown>>(
  dataSource: DataSource,
  schema: TSchema,
): TypeOrmDatabase<TSchema> {
  const repositories = {};
  for (const [name, entity] of Object.entries(schema)) {
    // Repositories need an initialized data source, so resolve them on access.
    Object.defineProperty(repositories, name, {
      enumerable: true,
      get: () => dataSource.getRepository(entity as EntityTarget<ObjectLiteral>),
    });
  }
  Object.defineProperty(dataSource, "repositories", { value: repositories });
  return dataSource as TypeOrmDatabase<TSchema>;
}

/**
 * The dialect-independent part of the TypeORM adapters. It creates the data source on the
 * storage through the driver, registers the outbox entities next to the collections', and
 * leaves opening it (and creating the outbox tables) to the local-change store's
 * `initialize`, which the sync client calls before anything touches the database.
 */
export function createTypeOrmProxyDBAdapter<C extends CollectionConfigMap, TDataSourceOptions>(
  config: TypeOrmProxyDBAdapterConfig<C, TDataSourceOptions>,
  driver: TypeOrmProxyDriver<TDataSourceOptions>,
): TypeOrmDBAdapter<C, BuildSchemaFromCollections<C>> {
  const { dbStorage, collections } = config;
  if (dbStorage.dialect !== driver.dialect) {
    throw new Error(
      `The TypeORM adapter is built for ${driver.dialect} but the storage speaks ${dbStorage.dialect}.`,
    );
  }
  const schema = buildSchemaFromCollections(collections);
  const { events, dirtyRecords, appliedEvents } = driver.localChangeEntities;
  const entities = [
    ...(Object.values(schema) as TypeOrmEntity[]),
    ...(config.entities ?? []),
    events,
    dirtyRecords,
    appliedEvents,
  ];
  const dataSource = driver.createDataSource(dbStorage, entities, config.dataSourceOptions);
  // SQLite drivers share one query runner per data source, so every statement sent while
  // one of its transactions is open joins it. Adapter transactions get a data source of
  // their own: statements on `dataSource` never see them uncommitted and wait their turn.
  const transactionSource = driver.createDataSource(dbStorage, entities, config.dataSourceOptions);
  let openingTransactionSource: Promise<unknown> | undefined;
  const openTransactionSource = () =>
    (openingTransactionSource ??= transactionSource.initialize().catch((error: unknown) => {
      openingTransactionSource = undefined;
      throw error;
    }));
  // The transaction data source is the adapter's own: it closes with `db`, and the next
  // transaction opens it again.
  const destroy = dataSource.destroy.bind(dataSource);
  dataSource.destroy = async () => {
    const opening = openingTransactionSource;
    openingTransactionSource = undefined;
    if (
      opening &&
      (await opening.then(
        () => true,
        () => false,
      ))
    ) {
      await transactionSource.destroy();
    }
    await destroy();
  };
  const db = createTypeOrmDatabase(dataSource, schema);
  const operations = createOperations(dataSource, schema, collections);
  // A second transaction on the shared query runner would nest inside an open one and
  // outlive its commit: run them one at a time.
  let lastTransaction: Promise<unknown> = Promise.resolve();
  const inTransaction = <T>(fn: (context: DBAdapterTransactionContext<C>) => Promise<T>) => {
    const next = lastTransaction.then(async () => {
      await openTransactionSource();
      return transactionSource.transaction((manager) =>
        fn({ operations: createOperations(manager, schema, collections), native: manager }),
      );
    });
    lastTransaction = next.catch(() => undefined);
    return next;
  };

  return {
    db,
    schema,
    queryBuilder: db,
    querySchema: schema,
    dbStorage,
    localChangeStore: createTypeOrmLocalChangeStore(dataSource, driver.localChangeEntities),
    ...operations,
    transaction<T>(
      fn: (tx: DBAdapterOperations<C>, context: DBAdapterTransactionContext<C>) => Promise<T>,
    ): Promise<T> {
      return inTransaction((context) => fn(context.operations, context));
    },
    commitLocalMutation({ mutate, persistOutboxEvent, persistDirtyRecord }) {
      return inTransaction(async (context) => {
        await mutate(context);
        await persistOutboxEvent(context);
        await persistDirtyRecord(context);
      });
    },
  };
}
