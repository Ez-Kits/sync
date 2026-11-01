import type { ChangeBusEvent } from "../change-bus";
import type {
  BaseDBAdapter,
  DBAdapterOperations,
  LocalMutationTransactionContext,
} from "../db-adapter";
import type { ILocalChangeStore, StoredChangeBusEvent } from "../local-change-store";

type LocalMutationBase = {
  collection: string;
  /** Primary key value of the written row. */
  id: unknown;
  /** Stringified primary key used by the outbox and dirty records. */
  recordId: string;
  eventId: string;
  createdAt: number;
};

/** A local write as it reached the database: an `upsert` became a `create` or an `update`. */
export type CommittedLocalMutation = LocalMutationBase &
  ({ type: "create" | "update"; data: unknown } | { type: "delete" });

/**
 * A structured-cloneable description of one local write. The storage owner turns it
 * into one atomic row + outbox + dirty-record commit, so it can cross a tab boundary.
 * An `upsert` inserts the row when its primary key is missing, else updates it.
 */
export type LocalMutation =
  | CommittedLocalMutation
  | (LocalMutationBase & { type: "upsert"; data: unknown });

/** What runs inside one local-mutation transaction. */
export interface LocalMutationWriter {
  /** Reads and writes of the open transaction. */
  readonly operations: DBAdapterOperations<any>;
  /**
   * Write the rows now, in order; their outbox events and dirty records are saved before the
   * transaction commits. Resolves to the mutations as applied.
   */
  apply(mutations: readonly LocalMutation[]): Promise<CommittedLocalMutation[]>;
}

export interface LocalMutationOutcome<T> {
  result: T;
  /** Every mutation `fn` applied, in order. */
  applied: CommittedLocalMutation[];
}

/** Destination for local writes: the owned database, or the owner over a channel. */
export interface MutationSink {
  /** Run `fn` in one local-mutation transaction: everything it applies commits, or nothing. */
  commit<T>(fn: (writer: LocalMutationWriter) => Promise<T>): Promise<LocalMutationOutcome<T>>;
}

export function toStoredChangeBusEvent(mutation: CommittedLocalMutation): StoredChangeBusEvent {
  return {
    id: mutation.eventId,
    type: mutation.type,
    collection: mutation.collection,
    data: mutation.type === "delete" ? { id: mutation.id } : mutation.data,
    recordId: mutation.recordId,
    createdAt: mutation.createdAt,
  };
}

export function toChangeBusEvent(mutation: CommittedLocalMutation): ChangeBusEvent<any> {
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

async function applyRow(
  operations: DBAdapterOperations<any>,
  mutation: LocalMutation,
): Promise<CommittedLocalMutation> {
  if (mutation.type === "delete") {
    await operations.delete(mutation.collection, mutation.id as never);
    return mutation;
  }
  let type = mutation.type;
  if (type === "upsert") {
    const existing = operations.getOptional
      ? await operations.getOptional(mutation.collection, mutation.id as never)
      : await operations.get(mutation.collection, mutation.id as never);
    type = existing === undefined ? "create" : "update";
  }
  await operations[type === "create" ? "insert" : "update"](
    mutation.collection,
    mutation.data as never,
  );
  return { ...mutation, type };
}

/**
 * Run `fn` against an atomic storage pair: the rows it applies, their outbox events and dirty
 * records commit in one transaction. The only caller of `commitLocalMutation`. A mutation of
 * a `localOnly` collection (one no sync adapter handles) leaves no pending outbox event or
 * dirty record; its event is still recorded as applied, for `isLocalMutationCommitted`.
 * `applied` collects what `fn` applied, so a caller still has it when the commit's
 * acknowledgement is lost.
 */
export async function executeLocalMutations<T>(
  db: BaseDBAdapter<any, any, any>,
  localChangeStore: ILocalChangeStore,
  fn: (writer: LocalMutationWriter) => Promise<T>,
  options: {
    localOnly?: (collection: string) => boolean;
    applied?: CommittedLocalMutation[];
  } = {},
): Promise<T> {
  if (typeof db.commitLocalMutation !== "function") {
    throw new Error("The database adapter must implement atomic local mutations.");
  }
  const applied = options.applied ?? [];
  const isLocalOnly = (mutation: CommittedLocalMutation) =>
    options.localOnly?.(mutation.collection) ?? false;
  let result!: T;
  await db.commitLocalMutation({
    mutate: async ({ operations }) => {
      result = await fn({
        operations,
        apply: async (mutations) => {
          const committed: CommittedLocalMutation[] = [];
          for (const mutation of mutations) {
            const done = await applyRow(operations, mutation);
            committed.push(done);
            applied.push(done);
          }
          return committed;
        },
      });
    },
    persistOutboxEvent: async (context: LocalMutationTransactionContext<any>) => {
      if (applied.length === 0) return;
      await localChangeStore.appendEvents(applied.map(toStoredChangeBusEvent), context.native);
      const localOnly = applied.filter(isLocalOnly).map(({ eventId }) => eventId);
      if (localOnly.length > 0) await localChangeStore.deleteEvents(localOnly, context.native);
    },
    persistDirtyRecord: async (context: LocalMutationTransactionContext<any>) => {
      for (const mutation of applied) {
        if (isLocalOnly(mutation)) continue;
        await localChangeStore.upsertDirtyRecord(
          {
            collection: mutation.collection,
            recordId: mutation.recordId,
            state: mutation.type === "delete" ? "deleted" : "dirty",
            updatedAt: mutation.createdAt,
          },
          context.native,
        );
      }
    },
  });
  return result;
}

/** Commit one mutation; see {@link executeLocalMutations}. Resolves to it as applied. */
export async function executeLocalMutation(
  db: BaseDBAdapter<any, any, any>,
  localChangeStore: ILocalChangeStore,
  mutation: LocalMutation,
  options: { localOnly?: boolean } = {},
): Promise<CommittedLocalMutation> {
  const [applied] = await executeLocalMutations(
    db,
    localChangeStore,
    (writer) => writer.apply([mutation]),
    { localOnly: () => options.localOnly ?? false },
  );
  return applied!;
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
  return {
    commit: async (fn) => {
      const applied: CommittedLocalMutation[] = [];
      const result = await executeLocalMutations(db, localChangeStore, fn, { applied });
      return { result, applied };
    },
  };
}
