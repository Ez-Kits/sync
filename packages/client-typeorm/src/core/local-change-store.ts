import type {
  AtomicLocalChangeStore,
  DirtyRecord,
  DirtyRecordKey,
  LocalChangeScope,
  StoredChangeBusEvent,
} from "@ez-kits/sync-client-core";
import {
  type EntitySchema,
  Table,
  type DataSource,
  type EntityManager,
  type EntityMetadata,
  type QueryDeepPartialEntity,
  type QueryRunner,
} from "typeorm";

/** An outbox row: the stored event and the position the database assigned it on insert. */
export type TypeOrmEventRow = StoredChangeBusEvent & {
  /** Increasing in commit order; pending events sort by it. */
  seq: number;
};

/** The predefined outbox and dirty-record entities of one dialect. */
export interface TypeOrmLocalChangeEntities {
  /** `seq` must be a generated primary key and `id` unique. */
  readonly events: EntitySchema<TypeOrmEventRow>;
  readonly dirtyRecords: EntitySchema<DirtyRecord>;
}

/** Version of the outbox tables the store reads and writes; 2 added the `seq` column. */
const SCHEMA_VERSION = 2;

const EVENT_FIELDS = ["id", "type", "collection", "data", "recordId", "createdAt"] as const;

const scopeWhere = (scope: LocalChangeScope | undefined) =>
  scope === undefined ? {} : { where: typeof scope === "string" ? { collection: scope } : scope };

async function readSchemaVersion(queryRunner: QueryRunner, events: EntityMetadata) {
  const rows: Array<{ value: number | string }> = await queryRunner.query(
    "SELECT value FROM ez_sync_meta WHERE key = 'schema_version'",
  );
  if (rows[0] !== undefined) return Number(rows[0].value);
  // Version 1 kept no meta table; its events table is the only trace of it.
  return (await queryRunner.hasTable(events.tablePath)) ? 1 : 0;
}

/**
 * Rebuild a version 1 events table (keyed by `id`, no `seq`) with the current metadata,
 * numbering its rows in their old `createdAt, id` order.
 */
async function upgradeEventsFromV1(
  db: DataSource,
  queryRunner: QueryRunner,
  events: EntityMetadata,
) {
  const escape = (name: string) => db.driver.escape(name);
  const table = events.tablePath.split(".").map(escape).join(".");
  const column = (property: string) =>
    escape(events.findColumnWithPropertyName(property)!.databaseName);
  const fields = EVENT_FIELDS.map(column).join(", ");
  const seq = column("seq");
  await queryRunner.query(`CREATE TEMP TABLE ez_sync_events_v1 AS SELECT * FROM ${table}`);
  await queryRunner.query(`DROP TABLE ${table}`);
  await queryRunner.createTable(Table.create(events, db.driver), false, true, true);
  await queryRunner.query(
    `INSERT INTO ${table} (${seq}, ${fields})
     SELECT row_number() OVER (ORDER BY ${column("createdAt")}, ${column("id")}), ${fields}
     FROM ez_sync_events_v1`,
  );
  if (db.options.type === "postgres") {
    // The copy set `seq` itself, so the sequence restarts after the copied rows.
    await queryRunner.query(
      `SELECT setval(pg_get_serial_sequence('${events.tablePath}', '${events.findColumnWithPropertyName("seq")!.databaseName}'), COALESCE(MAX(${seq}), 0) + 1, false) FROM ${table}`,
    );
  }
  await queryRunner.query("DROP TABLE ez_sync_events_v1");
}

/**
 * The outbox/dirty-record store of a TypeORM adapter, on the adapter's own data source.
 * Atomic callbacks and sync transactions pass the transaction's entity manager.
 */
export function createTypeOrmLocalChangeStore(
  db: DataSource,
  entities: TypeOrmLocalChangeEntities,
): AtomicLocalChangeStore<EntityManager> {
  const managerFor = (transactionContext?: unknown): EntityManager =>
    (transactionContext as EntityManager | undefined) ?? db.manager;
  const eventTarget = entities.events;
  const dirtyRecordTarget = entities.dirtyRecords;

  // Open the data source, then create or upgrade the two tables (with their keys) in one
  // transaction, so contexts sharing a storage cannot both do it.
  async function initialize() {
    if (!db.isInitialized) await db.initialize();
    await db.transaction(async (manager) => {
      const queryRunner = manager.queryRunner as QueryRunner;
      const events = db.getMetadata(eventTarget);
      await queryRunner.query(
        "CREATE TABLE IF NOT EXISTS ez_sync_meta (key TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL)",
      );
      const version = await readSchemaVersion(queryRunner, events);
      if (version >= SCHEMA_VERSION) return;
      if (version === 1) await upgradeEventsFromV1(db, queryRunner, events);
      for (const target of [eventTarget, dirtyRecordTarget]) {
        const metadata = db.getMetadata(target);
        if (await queryRunner.hasTable(metadata.tablePath)) continue;
        await queryRunner.createTable(Table.create(metadata, db.driver), true, true, true);
      }
      await queryRunner.query(
        `INSERT INTO ez_sync_meta (key, value) VALUES ('schema_version', ${SCHEMA_VERSION})
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      );
    });
  }
  // Concurrent calls of this context share one run: opening the data source twice fails.
  let initializing: Promise<void> | undefined;

  return {
    atomicLocalMutationCapability: "atomic",
    initialize() {
      initializing ??= initialize().finally(() => {
        initializing = undefined;
      });
      return initializing;
    },
    async appendEvents(events: StoredChangeBusEvent[], transactionContext) {
      if (events.length === 0) return;
      // Only the database assigns `seq`, even to an event read back and appended again.
      const values = events.map(({ id, type, collection, data, recordId, createdAt }) => ({
        id,
        type,
        collection,
        data,
        recordId,
        createdAt,
      }));
      await managerFor(transactionContext)
        .getRepository(eventTarget)
        .insert(values as QueryDeepPartialEntity<TypeOrmEventRow>[]);
    },
    async getPendingEvents(scope, transactionContext) {
      return managerFor(transactionContext)
        .getRepository(eventTarget)
        .find({
          ...scopeWhere(scope),
          select: [...EVENT_FIELDS],
          order: { seq: "ASC" },
        });
    },
    async deleteEvents(ids: string[], transactionContext) {
      const repository = managerFor(transactionContext).getRepository(eventTarget);
      for (const id of ids) await repository.delete({ id });
    },
    async upsertDirtyRecord(record: DirtyRecord, transactionContext) {
      await managerFor(transactionContext)
        .getRepository(dirtyRecordTarget)
        .upsert(record, ["collection", "recordId"]);
    },
    async removeDirtyRecords(keys: DirtyRecordKey[], transactionContext) {
      const repository = managerFor(transactionContext).getRepository(dirtyRecordTarget);
      for (const key of keys) await repository.delete(key);
    },
    async getDirtyRecords(scope, transactionContext) {
      return managerFor(transactionContext)
        .getRepository(dirtyRecordTarget)
        .find(scopeWhere(scope));
    },
  };
}
