import type { ILocalChangeStore } from "../local-change-store";

/**
 * The checkpoint key the client id is stored under (see `PushOptions.clientId`): it lives with
 * the outbox, so tabs sharing the database share it and wiping storage drops it. Reserved: no
 * collection may use this name. (Not a NUL prefix: PostgreSQL text can't hold NUL.)
 */
export const CLIENT_ID_KEY = "ez_sync:client_id";

const clientIds = new WeakMap<ILocalChangeStore, Promise<string>>();

/**
 * The database's client id, created when missing. Only the leading tab pushes, so only one
 * context ever creates it; the handlers of a context share one read.
 */
export function readClientId(store: ILocalChangeStore): Promise<string> {
  let clientId = clientIds.get(store);
  if (!clientId) {
    clientId = (async () => {
      const stored = await store.getCheckpoint(CLIENT_ID_KEY);
      if (stored !== undefined) return stored;
      const created = crypto.randomUUID();
      await store.saveCheckpoint(CLIENT_ID_KEY, created);
      return created;
    })();
    // A failed read is tried again by the next push.
    clientId.catch(() => clientIds.delete(store));
    clientIds.set(store, clientId);
  }
  return clientId;
}
