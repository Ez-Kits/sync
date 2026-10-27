import type { BaseDBAdapter } from "../db-adapter";
import type { AtomicLocalChangeStore } from "../local-change-store";
import { StorageCoordinator } from "./coordinator";
import type { CoordinatedStorageOptions, StorageRole } from "./types";

const coordinators = new WeakMap<object, StorageCoordinator<any, any, any>>();
const factoryToken: unique symbol = Symbol("coordinated-storage-factory");

/**
 * Client storage whose ownership is coordinated across tabs. Build it with
 * {@link createCoordinatedStorage}; sync clients reject any other object.
 */
export class CoordinatedStorage<
  DB extends BaseDBAdapter<any, any, any> = BaseDBAdapter<any, any, any>,
  Store extends AtomicLocalChangeStore = AtomicLocalChangeStore,
> {
  /** Resolves once this context can read and write, as owner or follower. */
  readonly ready: Promise<void>;
  declare private readonly types: [DB, Store];

  private constructor(coordinator: StorageCoordinator<any, DB, Store>) {
    coordinators.set(this, coordinator);
    this.ready = coordinator.resolve().then(() => undefined);
    // Readiness failures surface through `ready` consumers and sync status.
    this.ready.catch(() => undefined);
    Object.freeze(this);
  }

  get role(): StorageRole {
    return coordinators.get(this)!.role;
  }

  /** Notified whenever this context becomes the owner or a follower. */
  onRoleChange(listener: (role: StorageRole) => void): () => void {
    let last = this.role;
    return coordinators.get(this)!.subscribe({
      view: (view) => {
        if (view.role === last) return;
        last = view.role;
        listener(view.role);
      },
    });
  }

  /** Release ownership, close the database and stop listening to other tabs. */
  dispose(): Promise<void> {
    return coordinators.get(this)!.dispose();
  }

  static create<DB extends BaseDBAdapter<any, any, any>, Store extends AtomicLocalChangeStore>(
    coordinator: StorageCoordinator<any, DB, Store>,
    token: typeof factoryToken,
  ): CoordinatedStorage<DB, Store> {
    if (token !== factoryToken) {
      throw new Error("Coordinated storage must be created by createCoordinatedStorage.");
    }
    return new CoordinatedStorage(coordinator);
  }
}

/**
 * Wrap plain database factories so that one context owns the storage and the others
 * reach it through that owner. The owner is also the only context that syncs.
 */
export function createCoordinatedStorage<
  TDatabase,
  DB extends BaseDBAdapter<any, any, any>,
  Store extends AtomicLocalChangeStore,
  TRequest = unknown,
  TResponse = unknown,
>(
  options: CoordinatedStorageOptions<TDatabase, DB, Store, TRequest, TResponse>,
): CoordinatedStorage<DB, Store> {
  return CoordinatedStorage.create(
    new StorageCoordinator<TDatabase, DB, Store>(
      options as CoordinatedStorageOptions<TDatabase, DB, Store>,
    ),
    factoryToken,
  );
}

/** @internal Resolve the coordinator behind a storage, rejecting forged objects. */
export function getStorageCoordinator<
  DB extends BaseDBAdapter<any, any, any>,
  Store extends AtomicLocalChangeStore,
>(storage: CoordinatedStorage<DB, Store> | undefined): StorageCoordinator<unknown, DB, Store> {
  const coordinator = storage ? coordinators.get(storage) : undefined;
  if (!coordinator) {
    throw new Error("Sync clients require storage created by createCoordinatedStorage.");
  }
  return coordinator;
}
