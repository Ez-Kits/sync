import type {
  CollectionConfigMap,
  CollectionNames,
  ConfigForName,
  InferCollectionInsertModel,
  InferCollectionPrimaryFieldType,
  InferCollectionSelectModel,
  InferCollectionUpdateModel,
} from "../collection";
import type { DBStorage } from "../db-storage";
import type { AtomicLocalChangeStore } from "../local-change-store";

/**
 * CRUD operations available both on the adapter and inside {@link BaseDBAdapter.transaction}.
 */
export interface DBAdapterOperations<C extends CollectionConfigMap> {
  insert<N extends CollectionNames<C>>(
    collection: N,
    data: InferCollectionInsertModel<ConfigForName<C, N>>,
  ): Promise<void>;
  update<N extends CollectionNames<C>>(
    collection: N,
    data: InferCollectionUpdateModel<ConfigForName<C, N>>,
  ): Promise<void>;
  delete<N extends CollectionNames<C>>(
    collection: N,
    id: InferCollectionPrimaryFieldType<ConfigForName<C, N>>,
  ): Promise<void>;
  get<N extends CollectionNames<C>>(
    collection: N,
    id: InferCollectionPrimaryFieldType<ConfigForName<C, N>>,
  ): Promise<InferCollectionSelectModel<ConfigForName<C, N>>>;
  /** Return `undefined` only when the row is absent; database errors must reject. */
  getOptional?<N extends CollectionNames<C>>(
    collection: N,
    id: InferCollectionPrimaryFieldType<ConfigForName<C, N>>,
  ): Promise<InferCollectionSelectModel<ConfigForName<C, N>> | undefined>;
  getMany<N extends CollectionNames<C>>(
    collection: N,
  ): Promise<InferCollectionSelectModel<ConfigForName<C, N>>[]>;
}

/**
 * One open adapter transaction. Everything that must see or join it goes through it: CRUD
 * through `operations`, the local-change store by passing `native` as `transactionContext`.
 * A statement sent any other way waits until the transaction ends, so awaiting one inside
 * the transaction deadlocks until the transaction timeout.
 */
export interface DBAdapterTransactionContext<C extends CollectionConfigMap> {
  operations: DBAdapterOperations<C>;
  /** The adapter's own transaction handle (a Drizzle transaction database, a TypeORM entity manager). */
  native: unknown;
}

/** The transaction context `commitLocalMutation` passes to its callbacks. */
export type LocalMutationTransactionContext<C extends CollectionConfigMap> =
  DBAdapterTransactionContext<C>;

export interface BaseDBAdapter<
  C extends CollectionConfigMap,
  TQueryBuilder,
  TQuerySchema extends Record<CollectionNames<C>, unknown>,
> extends DBAdapterOperations<C> {
  queryBuilder: TQueryBuilder;
  querySchema: TQuerySchema;
  /** The storage every statement of this adapter runs on. */
  readonly dbStorage: DBStorage;
  /** Outbox and dirty records, kept in the same storage so local mutations commit atomically. */
  readonly localChangeStore: AtomicLocalChangeStore;
  /**
   * Release what the adapter holds on top of `dbStorage` (e.g. an ORM's data source). The
   * sync client's `dispose` calls it after sync stops and before it closes `dbStorage`; the
   * storage itself is not the adapter's to close.
   */
  close?(): Promise<void>;
  /**
   * Run adapter operations in a single database transaction (`dbStorage.transaction`).
   * All writes succeed together or none are applied. `context.operations` is `tx`; pass
   * `context.native` to the local-change store to read or write in the same transaction.
   */
  transaction<T>(
    fn: (tx: DBAdapterOperations<C>, context: DBAdapterTransactionContext<C>) => Promise<T>,
  ): Promise<T>;
  /** Atomically commit the row mutation with outbox and dirty-record writes. */
  commitLocalMutation(options: {
    mutate: (context: LocalMutationTransactionContext<C>) => Promise<void>;
    persistOutboxEvent: (context: LocalMutationTransactionContext<C>) => Promise<void>;
    persistDirtyRecord: (context: LocalMutationTransactionContext<C>) => Promise<void>;
  }): Promise<void>;
}
