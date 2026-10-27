import type {
  DirtyRecord,
  DirtyRecordKey,
  AtomicLocalChangeStore,
  StoredChangeBusEvent,
} from "@ez-kits/sync-client-core";
import {
  Table,
  type DataSource,
  type EntityManager,
  type EntityTarget,
  type ObjectLiteral,
} from "typeorm";
import type { EntityClass } from "./collection";

export interface TypeOrmLocalChangeStoreConfig<
  TDataSource extends DataSource,
  TEventEntity extends EntityClass<StoredChangeBusEvent>,
  TDirtyEntity extends EntityClass<DirtyRecord>,
> {
  db: TDataSource;
  eventEntity: TEventEntity;
  dirtyRecordEntity: TDirtyEntity;
}

export type TypeOrmSchemaTypeCheck<
  TEventEntity extends EntityClass<StoredChangeBusEvent>,
  TDirtyEntity extends EntityClass<DirtyRecord>,
> =
  StoredChangeBusEvent extends InstanceType<NoInfer<TEventEntity>>
    ? DirtyRecord extends InstanceType<NoInfer<TDirtyEntity>>
      ? []
      : [schemaError: never]
    : [schemaError: never];

/**
 * Create an outbox/dirty-record store in the same TypeORM database as the
 * collection adapter. Pass the transaction manager through atomic callbacks.
 */
export function createTypeOrmLocalChangeStore<
  TDataSource extends DataSource,
  TEventEntity extends EntityClass<StoredChangeBusEvent>,
  TDirtyEntity extends EntityClass<DirtyRecord>,
>(
  config: TypeOrmLocalChangeStoreConfig<TDataSource, TEventEntity, TDirtyEntity>,
  ...typeCheck: TypeOrmSchemaTypeCheck<TEventEntity, TDirtyEntity>
): AtomicLocalChangeStore<EntityManager> {
  void typeCheck;
  const { db, eventEntity, dirtyRecordEntity } = config;
  const managerFor = (transactionContext?: unknown): EntityManager =>
    (transactionContext as EntityManager | undefined) ?? db.manager;
  const eventTarget = eventEntity as EntityTarget<ObjectLiteral>;
  const dirtyRecordTarget = dirtyRecordEntity as EntityTarget<ObjectLiteral>;

  return {
    atomicLocalMutationCapability: "atomic",
    // Create the two entity tables (with their indices and unique keys) when missing.
    async initialize() {
      const queryRunner = db.createQueryRunner();
      try {
        for (const target of [eventTarget, dirtyRecordTarget]) {
          const metadata = db.getMetadata(target);
          if (await queryRunner.hasTable(metadata.tablePath)) continue;
          await queryRunner.createTable(Table.create(metadata, db.driver), true, true, true);
        }
      } finally {
        await queryRunner.release();
      }
    },
    async appendEvents(events: StoredChangeBusEvent[], transactionContext) {
      if (events.length === 0) return;
      await managerFor(transactionContext).getRepository(eventTarget).save(events);
    },
    async getPendingEvents(collection) {
      const rows = await db.manager.getRepository(eventTarget).find({
        ...(collection ? { where: { collection } } : {}),
        order: { createdAt: "ASC", id: "ASC" },
      });
      return rows as StoredChangeBusEvent[];
    },
    async deleteEvents(ids: string[]) {
      const repository = db.manager.getRepository(eventTarget);
      for (const id of ids) await repository.delete({ id });
    },
    async upsertDirtyRecord(record: DirtyRecord, transactionContext) {
      await managerFor(transactionContext)
        .getRepository(dirtyRecordTarget)
        .upsert(record, ["collection", "recordId"]);
    },
    async removeDirtyRecords(keys: DirtyRecordKey[]) {
      const repository = db.manager.getRepository(dirtyRecordTarget);
      for (const key of keys) await repository.delete(key);
    },
    async getDirtyRecords(collection) {
      const rows = await db.manager
        .getRepository(dirtyRecordTarget)
        .find(collection ? { where: { collection } } : {});
      return rows as DirtyRecord[];
    },
  };
}
