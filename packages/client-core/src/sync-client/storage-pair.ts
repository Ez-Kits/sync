import type { BaseDBAdapter } from "../db-adapter";
import type { AtomicLocalChangeStore } from "../local-change-store";

const atomicLocalMutationStorage: unique symbol = Symbol("atomic-local-mutation-storage");
const storagePairFactoryToken: unique symbol = Symbol("storage-pair-factory");

export class AtomicLocalMutationStorage<
  DB extends BaseDBAdapter<any, any, any> = BaseDBAdapter<any, any, any>,
  Store extends AtomicLocalChangeStore = AtomicLocalChangeStore,
> {
  readonly dbAdapter: DB;
  readonly localChangeStore: Store;
  readonly [atomicLocalMutationStorage]: (db: DB, store: Store) => boolean;

  private constructor(dbAdapter: DB, localChangeStore: Store) {
    this.dbAdapter = dbAdapter;
    this.localChangeStore = localChangeStore;
    this[atomicLocalMutationStorage] = (db, store) => this.matches(db, store);
    Object.freeze(this);
  }

  private matches(db: DB, store: Store): boolean {
    return db === this.dbAdapter && store === this.localChangeStore;
  }

  static create<DB extends BaseDBAdapter<any, any, any>, Store extends AtomicLocalChangeStore>(
    dbAdapter: DB,
    localChangeStore: Store,
    token: typeof storagePairFactoryToken,
  ): AtomicLocalMutationStorage<DB, Store> {
    if (token !== storagePairFactoryToken) {
      throw new Error("Atomic storage pairs must be created by a storage factory.");
    }
    return new AtomicLocalMutationStorage(dbAdapter, localChangeStore);
  }
}

/**
 * Create a client storage pair from one database handle. Both participants
 * must be constructed from the supplied handle and share its transaction.
 */
export function createAtomicLocalMutationStorage<
  TDatabase,
  DB extends BaseDBAdapter<any, any, any>,
  Store extends AtomicLocalChangeStore,
>(
  database: TDatabase,
  createDBAdapter: (database: TDatabase) => DB,
  createLocalChangeStore: (database: TDatabase) => Store,
): AtomicLocalMutationStorage<DB, Store> {
  return AtomicLocalMutationStorage.create(
    createDBAdapter(database),
    createLocalChangeStore(database),
    storagePairFactoryToken,
  );
}

export function assertAtomicLocalMutationStorage<
  DB extends BaseDBAdapter<any, any, any>,
  Store extends AtomicLocalChangeStore,
>(
  storage: AtomicLocalMutationStorage<DB, Store> | undefined,
): asserts storage is AtomicLocalMutationStorage<DB, Store> {
  if (
    !storage ||
    !storage[atomicLocalMutationStorage](storage.dbAdapter, storage.localChangeStore) ||
    typeof storage.dbAdapter?.commitLocalMutation !== "function" ||
    storage.localChangeStore?.atomicLocalMutationCapability !== "atomic"
  ) {
    throw new Error(
      "Sync clients require a paired database adapter and local-change store with atomic local mutations.",
    );
  }
}
