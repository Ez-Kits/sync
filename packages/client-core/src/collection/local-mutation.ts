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

/** Commit a mutation against an atomic storage pair. The only caller of `commitLocalMutation`. */
export async function executeLocalMutation(
  db: BaseDBAdapter<any, any, any>,
  localChangeStore: ILocalChangeStore,
  mutation: LocalMutation,
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
    persistOutboxEvent: (context: LocalMutationTransactionContext<any>) =>
      localChangeStore.appendEvents([event], context.native),
    persistDirtyRecord: (context: LocalMutationTransactionContext<any>) =>
      localChangeStore.upsertDirtyRecord(
        {
          collection: mutation.collection,
          recordId: mutation.recordId,
          state: mutation.type === "delete" ? "deleted" : "dirty",
          updatedAt: mutation.createdAt,
        },
        context.native,
      ),
  });
}

/**
 * Whether a retried mutation already reached the database. A pending outbox event proves
 * it; a create whose row exists was committed and already pushed. Updates and deletes
 * are value-idempotent, so re-applying them is safe.
 */
export async function isLocalMutationCommitted(
  db: BaseDBAdapter<any, any, any>,
  localChangeStore: ILocalChangeStore,
  mutation: LocalMutation,
): Promise<boolean> {
  const pending = await localChangeStore.getPendingEvents(mutation.collection);
  if (pending.some((event) => event.id === mutation.eventId)) return true;
  if (mutation.type !== "create") return false;
  const id = mutation.id as never;
  if (db.getOptional) return (await db.getOptional(mutation.collection, id)) !== undefined;
  try {
    // Adapters either throw or resolve undefined for a missing row.
    return (await db.get(mutation.collection, id)) !== undefined;
  } catch {
    return false;
  }
}

export function createLocalMutationSink(
  db: BaseDBAdapter<any, any, any>,
  localChangeStore: ILocalChangeStore,
): MutationSink {
  return { commit: (mutation) => executeLocalMutation(db, localChangeStore, mutation) };
}
