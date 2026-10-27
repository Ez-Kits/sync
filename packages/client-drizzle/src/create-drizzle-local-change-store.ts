import type {
  DirtyRecord,
  DirtyRecordKey,
  AtomicLocalChangeStore,
  StoredChangeBusEvent,
} from "@ez-kits/sync-client-core";
import {
  and,
  asc,
  eq,
  getColumns,
  inArray,
  type Column,
  type InferInsertModel,
  type Table,
} from "drizzle-orm";

export type DrizzleEventTable = Table & {
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

export interface DrizzleLocalChangeStoreTables<
  TEvents extends DrizzleEventTable,
  TDirtyRecords extends DrizzleDirtyRecordTable,
> {
  events: TEvents;
  dirtyRecords: TDirtyRecords;
}

export interface DrizzleLocalChangeStoreConfig<
  TDb,
  TEvents extends DrizzleEventTable,
  TDirtyRecords extends DrizzleDirtyRecordTable,
> {
  db: TDb;
  tables: DrizzleLocalChangeStoreTables<TEvents, TDirtyRecords>;
  /** Create `tables` when missing; must be idempotent (see `ILocalChangeStore.initialize`). */
  initialize: () => Promise<void>;
}

export type DrizzleSchemaTypeCheck<
  TEvents extends DrizzleEventTable,
  TDirtyRecords extends DrizzleDirtyRecordTable,
> =
  StoredChangeBusEvent extends InferInsertModel<TEvents>
    ? DirtyRecord extends InferInsertModel<TDirtyRecords>
      ? []
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
>(
  config: DrizzleLocalChangeStoreConfig<TDb, TEvents, TDirtyRecords>,
  ...typeCheck: DrizzleSchemaTypeCheck<TEvents, TDirtyRecords>
): AtomicLocalChangeStore {
  void typeCheck;
  const { db, tables, initialize } = config;
  const events = tables.events;
  const dirty = tables.dirtyRecords;
  const eventColumns = getColumns(events);
  const dirtyColumns = getColumns(dirty);

  const dbFor = (transactionContext?: unknown): any => transactionContext ?? db;
  const eventColumn = (key: string) => eventColumns[key as keyof typeof eventColumns] as any;
  const dirtyColumn = (key: string) => dirtyColumns[key as keyof typeof dirtyColumns] as any;

  return {
    atomicLocalMutationCapability: "atomic",
    initialize,
    async appendEvents(items: StoredChangeBusEvent[], transactionContext) {
      if (items.length === 0) return;
      await dbFor(transactionContext).insert(events).values(items);
    },
    async getPendingEvents(collection) {
      const query = dbFor().select().from(events);
      const rows = collection
        ? await query
            .where(eq(eventColumn("collection"), collection))
            .orderBy(asc(eventColumn("createdAt")), asc(eventColumn("id")))
        : await query.orderBy(asc(eventColumn("createdAt")), asc(eventColumn("id")));
      return rows as StoredChangeBusEvent[];
    },
    async deleteEvents(ids: string[]) {
      if (ids.length === 0) return;
      await dbFor()
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
    async removeDirtyRecords(keys: DirtyRecordKey[]) {
      for (const key of keys) {
        await dbFor()
          .delete(dirty)
          .where(
            and(
              eq(dirtyColumn("collection"), key.collection),
              eq(dirtyColumn("recordId"), key.recordId),
            ),
          );
      }
    },
    async getDirtyRecords(collection) {
      const query = dbFor().select().from(dirty);
      const rows = collection
        ? await query.where(eq(dirtyColumn("collection"), collection))
        : await query;
      return rows as DirtyRecord[];
    },
  };
}
