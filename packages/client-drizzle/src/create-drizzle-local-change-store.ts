import {
  APPLIED_EVENT_RETENTION_MS,
  type DirtyRecord,
  type DirtyRecordKey,
  type AtomicLocalChangeStore,
  type LocalChangeScope,
  type SkippedRemoteEvent,
  type PendingEventKey,
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

/** Serialized pull checkpoints, keyed by `collection`. */
export type DrizzleCheckpointTable = Table & {
  collection: Column;
  value: Column;
};

/** One row of a {@link DrizzleCheckpointTable}. */
export interface DrizzleCheckpoint {
  collection: string;
  value: string;
}

/** Skipped remote events (`SkippedRemoteEvent`), keyed by `collection` and `recordId`. */
export type DrizzleSkippedRemoteEventTable = Table & {
  collection: Column;
  recordId: Column;
  /** The event as JSON. */
  event: Column;
};

export interface DrizzleLocalChangeStoreTables<
  TEvents extends DrizzleEventTable,
  TDirtyRecords extends DrizzleDirtyRecordTable,
  TAppliedEvents extends DrizzleAppliedEventTable = DrizzleAppliedEventTable,
  TCheckpoints extends DrizzleCheckpointTable = DrizzleCheckpointTable,
  TSkippedRemoteEvents extends DrizzleSkippedRemoteEventTable = DrizzleSkippedRemoteEventTable,
> {
  events: TEvents;
  dirtyRecords: TDirtyRecords;
  appliedEvents: TAppliedEvents;
  checkpoints: TCheckpoints;
  skippedRemoteEvents: TSkippedRemoteEvents;
}

export interface DrizzleLocalChangeStoreConfig<
  TDb,
  TEvents extends DrizzleEventTable,
  TDirtyRecords extends DrizzleDirtyRecordTable,
  TAppliedEvents extends DrizzleAppliedEventTable = DrizzleAppliedEventTable,
  TCheckpoints extends DrizzleCheckpointTable = DrizzleCheckpointTable,
  TSkippedRemoteEvents extends DrizzleSkippedRemoteEventTable = DrizzleSkippedRemoteEventTable,
> {
  db: TDb;
  tables: DrizzleLocalChangeStoreTables<
    TEvents,
    TDirtyRecords,
    TAppliedEvents,
    TCheckpoints,
    TSkippedRemoteEvents
  >;
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
  TCheckpoints extends DrizzleCheckpointTable = DrizzleCheckpointTable,
  TSkippedRemoteEvents extends DrizzleSkippedRemoteEventTable = DrizzleSkippedRemoteEventTable,
> =
  StoredChangeBusEvent extends InferInsertModel<TEvents>
    ? DirtyRecord extends InferInsertModel<TDirtyRecords>
      ? DrizzleAppliedEvent extends InferInsertModel<TAppliedEvents>
        ? DrizzleCheckpoint extends InferInsertModel<TCheckpoints>
          ? SkippedRemoteEvent extends InferInsertModel<TSkippedRemoteEvents>
            ? []
            : [schemaError: never]
          : [schemaError: never]
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
  TCheckpoints extends DrizzleCheckpointTable = DrizzleCheckpointTable,
  TSkippedRemoteEvents extends DrizzleSkippedRemoteEventTable = DrizzleSkippedRemoteEventTable,
>(
  config: DrizzleLocalChangeStoreConfig<
    TDb,
    TEvents,
    TDirtyRecords,
    TAppliedEvents,
    TCheckpoints,
    TSkippedRemoteEvents
  >,
  ...typeCheck: DrizzleSchemaTypeCheck<
    TEvents,
    TDirtyRecords,
    TAppliedEvents,
    TCheckpoints,
    TSkippedRemoteEvents
  >
): AtomicLocalChangeStore {
  void typeCheck;
  const { db, tables, initialize } = config;
  const events = tables.events;
  const dirty = tables.dirtyRecords;
  const applied = tables.appliedEvents;
  const checkpoints = tables.checkpoints;
  const skipped = tables.skippedRemoteEvents;
  const eventColumns = getColumns(events);
  const dirtyColumns = getColumns(dirty);
  const appliedColumns = getColumns(applied);
  const checkpointColumns = getColumns(checkpoints);
  const skippedColumns = getColumns(skipped);

  const dbFor = (transactionContext?: unknown): any => transactionContext ?? db;
  const eventColumn = (key: string) => eventColumns[key as keyof typeof eventColumns] as any;
  const dirtyColumn = (key: string) => dirtyColumns[key as keyof typeof dirtyColumns] as any;
  const appliedColumn = (key: string) => appliedColumns[key as keyof typeof appliedColumns] as any;
  const checkpointColumn = (key: string) =>
    checkpointColumns[key as keyof typeof checkpointColumns] as any;
  const skippedColumn = (key: string) => skippedColumns[key as keyof typeof skippedColumns] as any;
  /** Insert `values`, or update `set` on the row with the same `target` key. */
  const upsert = async (
    transactionContext: unknown,
    table: Table,
    values: Record<string, unknown>,
    target: unknown[],
    set: Record<string, unknown>,
  ) => {
    const insert = dbFor(transactionContext).insert(table).values(values);
    if (typeof insert.onConflictDoUpdate === "function") {
      await insert.onConflictDoUpdate({ target, set });
      return;
    }
    if (typeof insert.onDuplicateKeyUpdate === "function") {
      await insert.onDuplicateKeyUpdate({ set });
      return;
    }
    throw new Error("The Drizzle dialect does not support local-change upserts");
  };
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
    async getPendingEventKeys(transactionContext) {
      return dbFor(transactionContext)
        .select({ id: eventColumn("id"), collection: eventColumn("collection") })
        .from(events) as Promise<PendingEventKey[]>;
    },
    async deleteEvents(ids: string[], transactionContext) {
      if (ids.length === 0) return;
      await dbFor(transactionContext)
        .delete(events)
        .where(inArray(eventColumn("id"), ids));
    },
    async upsertDirtyRecord(record: DirtyRecord, transactionContext) {
      await upsert(
        transactionContext,
        dirty,
        { ...record },
        [dirtyColumn("collection"), dirtyColumn("recordId")],
        { state: record.state, updatedAt: record.updatedAt },
      );
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
    async getCheckpoint(collection: string, transactionContext) {
      const rows = await dbFor(transactionContext)
        .select({ value: checkpointColumn("value") })
        .from(checkpoints)
        .where(eq(checkpointColumn("collection"), collection));
      return rows[0]?.value as string | undefined;
    },
    async saveCheckpoint(collection: string, value: string | undefined, transactionContext) {
      if (value === undefined) {
        await dbFor(transactionContext)
          .delete(checkpoints)
          .where(eq(checkpointColumn("collection"), collection));
        return;
      }
      await upsert(
        transactionContext,
        checkpoints,
        { collection, value },
        [checkpointColumn("collection")],
        { value },
      );
    },
    async getSkippedRemoteEvents(scope, transactionContext) {
      const query = dbFor(transactionContext)
        .select({
          collection: skippedColumn("collection"),
          recordId: skippedColumn("recordId"),
          event: skippedColumn("event"),
        })
        .from(skipped);
      const rows =
        scope === undefined ? await query : await query.where(scopeWhere(skippedColumn, scope));
      return rows as SkippedRemoteEvent[];
    },
    async upsertSkippedRemoteEvent(entry: SkippedRemoteEvent, transactionContext) {
      const { collection, recordId, event } = entry;
      await upsert(
        transactionContext,
        skipped,
        { collection, recordId, event },
        [skippedColumn("collection"), skippedColumn("recordId")],
        { event },
      );
    },
    async removeSkippedRemoteEvents(keys: DirtyRecordKey[], transactionContext) {
      for (const key of keys) {
        await dbFor(transactionContext).delete(skipped).where(scopeWhere(skippedColumn, key));
      }
    },
  };
}
