import type { BaseDBAdapter, CollectionConfigMap, SyncClient } from "@ez-kits/sync-client-core";
import { createSyncClient } from "@ez-kits/sync-client-core";
import type { CreateScopedSyncClientReactOptions } from "./types.ts";

interface Entry<T> {
  client: Promise<T>;
  refs: number;
  releaseTimer?: ReturnType<typeof setTimeout>;
}

export interface ScopedClientLease<T> {
  /** Resolves once the scope's database is ready; rejects when it cannot open. */
  client: Promise<T>;
  release: () => void;
}

/**
 * One client per scope, shared by every provider rendering that scope. A client is disposed
 * a tick after its last provider lets go, so a `StrictMode` remount reuses it; a scope opened
 * again waits for its previous client to finish closing.
 */
export function createScopedClients<
  C extends CollectionConfigMap,
  DB extends BaseDBAdapter<C, any, any>,
  TCheckpoint,
>({ createConfig }: CreateScopedSyncClientReactOptions<C, DB, TCheckpoint>) {
  type Client = SyncClient<C, DB, TCheckpoint>;
  const entries = new Map<string, Entry<Client>>();
  const closing = new Map<string, Promise<void>>();

  async function open(scope: string): Promise<Client> {
    return (closing.get(scope) ?? Promise.resolve()).then(async () => {
      const config = createConfig(scope);
      const client = createSyncClient<C, DB, TCheckpoint>(config);
      try {
        await config.dbAdapter.dbStorage.ready;
      } catch (error) {
        await client.dispose().catch(() => undefined);
        throw error;
      }
      return client;
    });
  }

  function dispose(scope: string, entry: Entry<Client>): void {
    entries.delete(scope);
    const done = entry.client.then(
      (client) => client.dispose(),
      () => undefined,
    );
    const settled = done.catch(() => undefined);
    closing.set(scope, settled);
    void settled.then(() => {
      if (closing.get(scope) === settled) closing.delete(scope);
    });
  }

  return {
    acquire(scope: string): ScopedClientLease<Client> {
      let entry = entries.get(scope);
      if (entry) {
        clearTimeout(entry.releaseTimer);
        entry.releaseTimer = undefined;
        entry.refs++;
      } else {
        entry = { client: open(scope), refs: 1 };
        entry.client.catch(() => undefined);
        entries.set(scope, entry);
      }
      const owned = entry;
      let released = false;
      return {
        client: owned.client,
        release: () => {
          if (released) return;
          released = true;
          if (--owned.refs > 0) return;
          // A new lease of the scope clears the timer, so it only fires for an unused entry.
          owned.releaseTimer = setTimeout(() => dispose(scope, owned), 0);
        },
      };
    },
  };
}
