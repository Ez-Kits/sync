import type {
  AtomicLocalChangeStore,
  DirtyRecord,
  DirtyRecordKey,
  StoredChangeBusEvent,
} from "@ez-kits/sync-client-core";
import {
  type EntitySchema,
  Table,
  type DataSource,
  type EntityManager,
  type QueryRunner,
} from "typeorm";

/** The predefined outbox and dirty-record entities of one dialect. */
export interface TypeOrmLocalChangeEntities {
  readonly events: EntitySchema<StoredChangeBusEvent>;
  readonly dirtyRecords: EntitySchema<DirtyRecord>;
}

/**
 * The outbox/dirty-record store of a TypeORM adapter, on the adapter's own data source.
 * Atomic callbacks pass the transaction's entity manager.
 */
export function createTypeOrmLocalChangeStore(
  db: DataSource,
  entities: TypeOrmLocalChangeEntities,
): AtomicLocalChangeStore<EntityManager> {
  const managerFor = (transactionContext?: unknown): EntityManager =>
    (transactionContext as EntityManager | undefined) ?? db.manager;
  const eventTarget = entities.events;
  const dirtyRecordTarget = entities.dirtyRecords;

  return {
    atomicLocalMutationCapability: "atomic",
    // Open the data source, then create the two tables (with their keys) when missing, in
    // one transaction so contexts sharing a storage cannot both create them.
    async initialize() {
      if (!db.isInitialized) await db.initialize();
      await db.transaction(async (manager) => {
        const queryRunner = manager.queryRunner as QueryRunner;
        for (const target of [eventTarget, dirtyRecordTarget]) {
          const metadata = db.getMetadata(target);
          if (await queryRunner.hasTable(metadata.tablePath)) continue;
          await queryRunner.createTable(Table.create(metadata, db.driver), true, true, true);
        }
      });
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
      return rows;
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
      return rows;
    },
  };
}
