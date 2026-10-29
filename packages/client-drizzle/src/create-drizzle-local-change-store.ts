import {
  APPLIED_EVENT_RETENTION_MS,
  type DirtyRecord,
  type DirtyRecordKey,
  type AtomicLocalChangeStore,
  type LocalChangeScope,
  type StoredChangeBusEvent,
} from "@ez-kits/sync-client-core";
import {
  and,
  asc,
  eq,
  getColumns,
  inArray,
  lt,
  type Column,
  type InferInsertModel,
  type Table,
} from "drizzle-orm";

export type DrizzleEventTable = Table & {
  /** Assigned by the database on insert, increasing in commit order; pending events sort by it. */
  seq: Column;
  id: Column;
  type: Column;
  collection: Column;
  data: Column;
  recordId: Column;
  createdAt: Column;
};

export type DrizzleDirtyRecordTable = Table & {
  collection: Column;
  recordId: Column;
  state: Column;
  updatedAt: Column;
};

/** The `id`s of appended events, kept after acknowledgement so retries can find them. */
export type DrizzleAppliedEventTable = Table & {
  eventId: Column;
  /** The event's `createdAt`; records are pruned by it. */
  appliedAt: Column;
};

/** One row of a {@link DrizzleAppliedEventTable}. */
export interface DrizzleAppliedEvent {
  eventId: string;
  appliedAt: number;
}

export interface DrizzleLocalChangeStoreTables<
  TEvents extends DrizzleEventTable,
  TDirtyRecords extends DrizzleDirtyRecordTable,
  TAppliedEvents extends DrizzleAppliedEventTable = DrizzleAppliedEventTable,
> {
  events: TEvents;
  dirtyRecords: TDirtyRecords;
  appliedEvents: TAppliedEvents;
}

export interface DrizzleLocalChangeStoreConfig<
  TDb,
  TEvents extends DrizzleEventTable,
  TDirtyRecords extends DrizzleDirtyRecordTable,
  TAppliedEvents extends DrizzleAppliedEventTable = DrizzleAppliedEventTable,
> {
  db: TDb;
  tables: DrizzleLocalChangeStoreTables<TEvents, TDirtyRecords, TAppliedEvents>;
  /**
   * Create `tables` when missing and upgrade older versions of them; must be idempotent and
   * safe to run concurrently (see `ILocalChangeStore.initialize`).
   */
  initialize: () => Promise<void>;
}

/** `seq` must be database-assigned: an insert of a {@link StoredChangeBusEvent} omits it. */
export type DrizzleSchemaTypeCheck<
  TEvents extends DrizzleEventTable,
  TDirtyRecords extends DrizzleDirtyRecordTable,
  TAppliedEvents extends DrizzleAppliedEventTable = DrizzleAppliedEventTable,
> =
  StoredChangeBusEvent extends InferInsertModel<TEvents>
    ? DirtyRecord extends InferInsertModel<TDirtyRecords>
      ? DrizzleAppliedEvent extends InferInsertModel<TAppliedEvents>
        ? []
        : [schemaError: never]
      : [schemaError: never]
    : [schemaError: never];

/**
 * Create an outbox/dirty-record store in the same Drizzle database as the
 * collection adapter. Pass the transaction handle through atomic callbacks.
 */
export function createDrizzleLocalChangeStore<
  TDb,
  TEvents extends DrizzleEventTable,
  TDirtyRecords extends DrizzleDirtyRecordTable,
  TAppliedEvents extends DrizzleAppliedEventTable = DrizzleAppliedEventTable,
>(
  config: DrizzleLocalChangeStoreConfig<TDb, TEvents, TDirtyRecords, TAppliedEvents>,
  ...typeCheck: DrizzleSchemaTypeCheck<TEvents, TDirtyRecords, TAppliedEvents>
): AtomicLocalChangeStore {
  void typeCheck;
  const { db, tables, initialize } = config;
  const events = tables.events;
  const dirty = tables.dirtyRecords;
  const applied = tables.appliedEvents;
  const eventColumns = getColumns(events);
  const dirtyColumns = getColumns(dirty);
  const appliedColumns = getColumns(applied);

  const dbFor = (transactionContext?: unknown): any => transactionContext ?? db;
  const eventColumn = (key: string) => eventColumns[key as keyof typeof eventColumns] as any;
  const dirtyColumn = (key: string) => dirtyColumns[key as keyof typeof dirtyColumns] as any;
  const appliedColumn = (key: string) => appliedColumns[key as keyof typeof appliedColumns] as any;
  const scopeWhere = (column: (key: string) => any, scope: LocalChangeScope) =>
    typeof scope === "string"
      ? eq(column("collection"), scope)
      : and(eq(column("collection"), scope.collection), eq(column("recordId"), scope.recordId));
  // Every stored field but `seq`, which only orders the rows.
  const eventFields = {
    id: eventColumn("id"),
    type: eventColumn("type"),
    collection: eventColumn("collection"),
    data: eventColumn("data"),
    recordId: eventColumn("recordId"),
    createdAt: eventColumn("createdAt"),
  };

  return {
    atomicLocalMutationCapability: "atomic",
    initialize,
    async appendEvents(items: StoredChangeBusEvent[], transactionContext) {
      if (items.length === 0) return;
      // Only the database assigns `seq`, even to an event read back and appended again.
      const values = items.map(({ id, type, collection, data, recordId, createdAt }) => ({
        id,
        type,
        collection,
        data,
        recordId,
        createdAt,
      }));
      const target = dbFor(transactionContext);
      await target.insert(events).values(values);
      const newest = Math.max(...items.map((event) => event.createdAt));
      await target
        .delete(applied)
        .where(lt(appliedColumn("appliedAt"), newest - APPLIED_EVENT_RETENTION_MS));
      await target
        .insert(applied)
        .values(items.map((event) => ({ eventId: event.id, appliedAt: event.createdAt })));
    },
    async hasAppliedEvent(eventId: string, transactionContext) {
      const rows = await dbFor(transactionContext)
        .select({ eventId: appliedColumn("eventId") })
        .from(applied)
        .where(eq(appliedColumn("eventId"), eventId));
      return rows.length > 0;
    },
    async getPendingEvents(scope, transactionContext) {
      const query = dbFor(transactionContext).select(eventFields).from(events);
      const rows = await (
        scope === undefined ? query : query.where(scopeWhere(eventColumn, scope))
      ).orderBy(asc(eventColumn("seq")));
      return rows as StoredChangeBusEvent[];
    },
    async deleteEvents(ids: string[], transactionContext) {
      if (ids.length === 0) return;
      await dbFor(transactionContext)
        .delete(events)
        .where(inArray(eventColumn("id"), ids));
    },
    async upsertDirtyRecord(record: DirtyRecord, transactionContext) {
      const target = dbFor(transactionContext);
      const insert = target.insert(dirty).values(record);
      const set = { state: record.state, updatedAt: record.updatedAt };
      if (typeof insert.onConflictDoUpdate === "function") {
        await insert.onConflictDoUpdate({
          target: [dirtyColumn("collection"), dirtyColumn("recordId")],
          set,
        });
        return;
      }
      if (typeof insert.onDuplicateKeyUpdate === "function") {
        await insert.onDuplicateKeyUpdate({ set });
        return;
      }
      throw new Error("The Drizzle dialect does not support dirty-record upserts");
    },
    async removeDirtyRecords(keys: DirtyRecordKey[], transactionContext) {
      for (const key of keys) {
        await dbFor(transactionContext).delete(dirty).where(scopeWhere(dirtyColumn, key));
      }
    },
    async getDirtyRecords(scope, transactionContext) {
      const query = dbFor(transactionContext).select().from(dirty);
      const rows =
        scope === undefined ? await query : await query.where(scopeWhere(dirtyColumn, scope));
      return rows as DirtyRecord[];
    },
  };
}
