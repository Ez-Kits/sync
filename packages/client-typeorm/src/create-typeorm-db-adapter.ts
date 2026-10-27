import type {
  CollectionConfigMap,
  DirtyRecord,
  StoredChangeBusEvent,
  CollectionNames,
  ConfigForName,
  DBAdapterOperations,
  InferCollectionInsertModel,
  InferCollectionPrimaryFieldType,
  InferCollectionSelectModel,
  InferCollectionUpdateModel,
} from "@ez-kits/sync-client-core";
import type { DataSource, EntityManager, EntityTarget, ObjectLiteral } from "typeorm";
import {
  buildSchemaFromCollections,
  type BuildSchemaFromCollections,
  type EntityClass,
} from "./collection";
import { createTypeOrmDBStorage } from "./create-typeorm-db-storage";
import {
  createTypeOrmLocalChangeStore,
  type TypeOrmSchemaTypeCheck,
} from "./create-typeorm-local-change-store";
import type { TypeOrmDBAdapter, TypeOrmDBAdapterConfig } from "./types";

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
    async insert<N extends CollectionNames<C>>(
      collection: N,
      data: InferCollectionInsertModel<ConfigForName<C, N>>,
    ): Promise<void> {
      const entity = resolvedSchema[collection] as EntityTarget<ObjectLiteral>;
      await source.getRepository(entity).save(data as ObjectLiteral);
    },
    async update<N extends CollectionNames<C>>(
      collection: N,
      data: InferCollectionUpdateModel<ConfigForName<C, N>>,
    ): Promise<void> {
      const entity = resolvedSchema[collection] as EntityTarget<ObjectLiteral>;
      await source.getRepository(entity).save(data as ObjectLiteral);
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

/**
 * A TypeORM adapter with its outbox in the same data source. TypeORM runs in this
 * context only, so multi-tab apps need a data source whose engine is shared across tabs.
 */
export function createTypeOrmDBAdapter<
  C extends CollectionConfigMap,
  TDataSource extends DataSource = DataSource,
  TSchema extends Record<CollectionNames<C>, unknown> = BuildSchemaFromCollections<C>,
  TEventEntity extends EntityClass<StoredChangeBusEvent> = EntityClass<StoredChangeBusEvent>,
  TDirtyEntity extends EntityClass<DirtyRecord> = EntityClass<DirtyRecord>,
>(
  adapter: TypeOrmDBAdapterConfig<C, TDataSource, TSchema, TEventEntity, TDirtyEntity>,
  ...typeCheck: TypeOrmSchemaTypeCheck<TEventEntity, TDirtyEntity>
): TypeOrmDBAdapter<C, TDataSource, TSchema> {
  const { db, collections, eventEntity, dirtyRecordEntity } = adapter;
  let schema: TSchema | undefined = adapter.schema;

  if (!schema) {
    schema = buildSchemaFromCollections(collections) as TSchema;
  }

  const resolvedSchema = schema;
  const operations = createOperations(db, resolvedSchema, collections);

  return {
    db,
    schema: resolvedSchema,
    queryBuilder: db,
    querySchema: resolvedSchema,
    dbStorage: adapter.dbStorage ?? createTypeOrmDBStorage(db),
    localChangeStore: createTypeOrmLocalChangeStore(
      { db, eventEntity, dirtyRecordEntity },
      ...typeCheck,
    ),
    ...operations,
    async transaction<T>(fn: (tx: DBAdapterOperations<C>) => Promise<T>): Promise<T> {
      return db.transaction((manager) =>
        fn(createOperations(manager, resolvedSchema, collections)),
      );
    },
    async commitLocalMutation({ mutate, persistOutboxEvent, persistDirtyRecord }) {
      return db.transaction(async (manager) => {
        const context = {
          operations: createOperations(manager, resolvedSchema, collections),
          native: manager,
        };
        await mutate(context);
        await persistOutboxEvent(context);
        await persistDirtyRecord(context);
      });
    },
  };
}
