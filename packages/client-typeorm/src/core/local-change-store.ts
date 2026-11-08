import {
  APPLIED_EVENT_RETENTION_MS,
  type AtomicLocalChangeStore,
  type RecordKey,
  type LocalChangeScope,
  type RecordRevision,
  type SkippedRemoteEvent,
  type StoredChangeBusEvent,
} from "@ez-kits/sync-client-core";
import {
  type EntitySchema,
  LessThan,
  Table,
  type DataSource,
  type EntityManager,
  type QueryDeepPartialEntity,
  type QueryRunner,
} from "typeorm";

/** An outbox row: the stored event and the position the database assigned it on insert. */
export type TypeOrmEventRow = StoredChangeBusEvent & {
  /** Increasing in commit order; pending events sort by it. */
  seq: number;
};

/** The `id` of an appended event, kept after acknowledgement so retries can find it. */
export interface TypeOrmAppliedEventRow {
  eventId: string;
  /** The event's `createdAt`; records are pruned by it. */
  appliedAt: number;
}

/** A collection's serialized pull checkpoint. */
export interface TypeOrmCheckpointRow {
  collection: string;
  value: string;
}

/**
 * The predefined outbox, applied-event, checkpoint, skipped-event and revision
 * entities of one dialect.
 */
export interface TypeOrmLocalChangeEntities {
  /** `seq` must be a generated primary key and `id` unique. */
  readonly events: EntitySchema<TypeOrmEventRow>;
  /** `eventId` must be the primary key. */
  readonly appliedEvents: EntitySchema<TypeOrmAppliedEventRow>;
  /** `collection` must be the primary key. */
  readonly checkpoints: EntitySchema<TypeOrmCheckpointRow>;
  /** `collection` and `recordId` must be the primary key; `event` a JSON column. */
  readonly skippedRemoteEvents: EntitySchema<SkippedRemoteEvent>;
  /** `collection` and `recordId` must be the primary key. */
  readonly revisions: EntitySchema<RecordRevision>;
}

/**
 * Version of the outbox tables the store reads and writes. 5 added the `ez_sync_revisions`
 * table; 6 dropped `ez_sync_dirty_records`.
 */
const SCHEMA_VERSION = 6;

const EVENT_FIELDS = ["id", "type", "collection", "data", "recordId", "createdAt"] as const;

const scopeWhere = (scope: LocalChangeScope | undefined) =>
  scope === undefined ? {} : { where: typeof scope === "string" ? { collection: scope } : scope };

async function readSchemaVersion(queryRunner: QueryRunner) {
  const rows: Array<{ value: number | string }> = await queryRunner.query(
    "SELECT value FROM ez_sync_meta WHERE key = 'schema_version'",
  );
  return Number(rows[0]?.value ?? 0);
}

/**
 * The outbox store of a TypeORM adapter, on the adapter's own data source.
 * Atomic callbacks and sync transactions pass the transaction's entity manager.
 */
export function createTypeOrmLocalChangeStore(
  db: DataSource,
  entities: TypeOrmLocalChangeEntities,
): AtomicLocalChangeStore<EntityManager> {
  const managerFor = (transactionContext?: unknown): EntityManager =>
    (transactionContext as EntityManager | undefined) ?? db.manager;
  const eventTarget = entities.events;
  const appliedEventTarget = entities.appliedEvents;
  const checkpointTarget = entities.checkpoints;
  const skippedEventTarget = entities.skippedRemoteEvents;
  const revisionTarget = entities.revisions;

  // Open the data source, then create the missing tables (with their keys) in one
  // transaction, so contexts sharing a storage cannot both do it.
  async function initialize() {
    if (!db.isInitialized) await db.initialize();
    await db.transaction(async (manager) => {
      const queryRunner = manager.queryRunner as QueryRunner;
      await queryRunner.query(
        "CREATE TABLE IF NOT EXISTS ez_sync_meta (key TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL)",
      );
      if ((await readSchemaVersion(queryRunner)) >= SCHEMA_VERSION) return;
      for (const target of [
        eventTarget,
        appliedEventTarget,
        checkpointTarget,
        skippedEventTarget,
        revisionTarget,
      ]) {
        const metadata = db.getMetadata(target);
        await queryRunner.createTable(Table.create(metadata, db.driver), true, true, true);
      }
      await queryRunner.query("DROP TABLE IF EXISTS ez_sync_dirty_records");
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
      const manager = managerFor(transactionContext);
      await manager
        .getRepository(eventTarget)
        .insert(values as QueryDeepPartialEntity<TypeOrmEventRow>[]);
      const applied = manager.getRepository(appliedEventTarget);
      const newest = Math.max(...events.map((event) => event.createdAt));
      await applied.delete({ appliedAt: LessThan(newest - APPLIED_EVENT_RETENTION_MS) });
      await applied.insert(
        events.map((event) => ({ eventId: event.id, appliedAt: event.createdAt })),
      );
    },
    async hasAppliedEvent(eventId: string, transactionContext) {
      return managerFor(transactionContext).getRepository(appliedEventTarget).existsBy({ eventId });
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
    async getPendingEventKeys(transactionContext) {
      return managerFor(transactionContext)
        .getRepository(eventTarget)
        .find({ select: ["id", "collection"] });
    },
    async deleteEvents(ids: string[], transactionContext) {
      const repository = managerFor(transactionContext).getRepository(eventTarget);
      for (const id of ids) await repository.delete({ id });
    },
    async getCheckpoint(collection: string, transactionContext) {
      const row = await managerFor(transactionContext)
        .getRepository(checkpointTarget)
        .findOneBy({ collection });
      return row?.value;
    },
    async saveCheckpoint(collection: string, value: string | undefined, transactionContext) {
      const repository = managerFor(transactionContext).getRepository(checkpointTarget);
      if (value === undefined) await repository.delete({ collection });
      else await repository.upsert({ collection, value }, ["collection"]);
    },
    async getSkippedRemoteEvents(scope, transactionContext) {
      return managerFor(transactionContext)
        .getRepository(skippedEventTarget)
        .find(scopeWhere(scope));
    },
    async upsertSkippedRemoteEvent(entry: SkippedRemoteEvent, transactionContext) {
      const { collection, recordId, event } = entry;
      await managerFor(transactionContext)
        .getRepository(skippedEventTarget)
        .upsert({ collection, recordId, event } as QueryDeepPartialEntity<SkippedRemoteEvent>, [
          "collection",
          "recordId",
        ]);
    },
    async removeSkippedRemoteEvents(keys: RecordKey[], transactionContext) {
      const repository = managerFor(transactionContext).getRepository(skippedEventTarget);
      for (const { collection, recordId } of keys)
        await repository.delete({ collection, recordId });
    },
    async getRevision({ collection, recordId }: RecordKey, transactionContext) {
      const row = await managerFor(transactionContext)
        .getRepository(revisionTarget)
        .findOneBy({ collection, recordId });
      return row?.rev;
    },
    async upsertRevision({ collection, recordId, rev }: RecordRevision, transactionContext) {
      await managerFor(transactionContext)
        .getRepository(revisionTarget)
        .upsert({ collection, recordId, rev }, ["collection", "recordId"]);
    },
    async removeRevisions(collection: string, transactionContext) {
      const manager = managerFor(transactionContext);
      const pendingRecordIds = manager
        .getRepository(eventTarget)
        .createQueryBuilder("event")
        .select("event.recordId")
        .where("event.collection = :collection")
        .getQuery();
      await manager
        .createQueryBuilder()
        .delete()
        .from(revisionTarget)
        .where(`collection = :collection AND recordId NOT IN (${pendingRecordIds})`, { collection })
        .execute();
    },
  };
}
