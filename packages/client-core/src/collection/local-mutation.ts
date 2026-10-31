import type { ChangeBusEvent } from "../change-bus";
import type { BaseDBAdapter, LocalMutationTransactionContext } from "../db-adapter";
import type { ILocalChangeStore, StoredChangeBusEvent } from "../local-change-store";

/**
 * A structured-cloneable description of one local write. The storage owner turns it
 * into one atomic row + outbox + dirty-record commit, so it can cross a tab boundary.
 */
export type LocalMutation = {
  collection: string;
  /** Primary key value of the written row. */
  id: unknown;
  /** Stringified primary key used by the outbox and dirty records. */
  recordId: string;
  eventId: string;
  createdAt: number;
} & ({ type: "create" | "update"; data: unknown } | { type: "delete" });

/** Destination for local writes: the owned database, or the owner over a channel. */
export interface MutationSink {
  commit(mutation: LocalMutation): Promise<void>;
}

export function toStoredChangeBusEvent(mutation: LocalMutation): StoredChangeBusEvent {
  return {
    id: mutation.eventId,
    type: mutation.type,
    collection: mutation.collection,
    data: mutation.type === "delete" ? null : mutation.data,
    recordId: mutation.recordId,
    createdAt: mutation.createdAt,
  };
}

export function toChangeBusEvent(mutation: LocalMutation): ChangeBusEvent<any> {
  if (mutation.type === "delete") {
    return {
      type: "delete",
      collection: mutation.collection,
      id: mutation.id,
      deletedAt: mutation.createdAt,
      eventId: mutation.eventId,
    };
  }
  return {
    type: mutation.type,
    collection: mutation.collection,
    data: mutation.data,
    eventId: mutation.eventId,
  };
}

/**
 * Commit a mutation against an atomic storage pair. The only caller of `commitLocalMutation`.
 * A `localOnly` mutation (of a collection no sync adapter handles) leaves no pending outbox
 * event or dirty record; its event is still recorded as applied, for `isLocalMutationCommitted`.
 */
export async function executeLocalMutation(
  db: BaseDBAdapter<any, any, any>,
  localChangeStore: ILocalChangeStore,
  mutation: LocalMutation,
  options: { localOnly?: boolean } = {},
): Promise<void> {
  if (typeof db.commitLocalMutation !== "function") {
    throw new Error("The database adapter must implement atomic local mutations.");
  }
  const event = toStoredChangeBusEvent(mutation);
  await db.commitLocalMutation({
    mutate: ({ operations }) =>
      mutation.type === "delete"
        ? operations.delete(mutation.collection, mutation.id as never)
        : operations[mutation.type === "create" ? "insert" : "update"](
            mutation.collection,
            mutation.data as never,
          ),
    persistOutboxEvent: async (context: LocalMutationTransactionContext<any>) => {
      await localChangeStore.appendEvents([event], context.native);
      if (options.localOnly) await localChangeStore.deleteEvents([event.id], context.native);
    },
    persistDirtyRecord: async (context: LocalMutationTransactionContext<any>) => {
      if (options.localOnly) return;
      await localChangeStore.upsertDirtyRecord(
        {
          collection: mutation.collection,
          recordId: mutation.recordId,
          state: mutation.type === "delete" ? "deleted" : "dirty",
          updatedAt: mutation.createdAt,
        },
        context.native,
      );
    },
  });
}

/**
 * Whether a retried mutation already reached the database. Its outbox event is recorded
 * as applied in the mutation's transaction and stays recorded after it is pushed, so a
 * retry never re-applies a write that a newer one may have replaced since.
 */
export function isLocalMutationCommitted(
  localChangeStore: ILocalChangeStore,
  mutation: LocalMutation,
): Promise<boolean> {
  return localChangeStore.hasAppliedEvent(mutation.eventId);
}

export function createLocalMutationSink(
  db: BaseDBAdapter<any, any, any>,
  localChangeStore: ILocalChangeStore,
): MutationSink {
  return { commit: (mutation) => executeLocalMutation(db, localChangeStore, mutation) };
}
