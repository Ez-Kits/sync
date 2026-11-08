import type { ChangeBusEvent } from "../change-bus";
import type { CollectionConfigMap, CollectionNames } from "../collection";
import type { DBAdapterTransactionContext } from "../db-adapter";
import type { ILocalChangeStore, RecordKey, StoredChangeBusEvent } from "../local-change-store";
import type { SyncHandlerDataMap } from "./base-sync-handler";
import { coerceRecordId, recordKeyString } from "./record-events";
import type { ConflictResolution } from "./types";

/** What reconciling needs from its handler. */
export interface RemoteEventReconciliation<C extends CollectionConfigMap> {
  store: ILocalChangeStore;
  resolveConflict: ConflictResolution<SyncHandlerDataMap<C>> | undefined;
  recordKeyOf(event: ChangeBusEvent<SyncHandlerDataMap<C>>): RecordKey;
  primaryKeyOf(event: ChangeBusEvent<SyncHandlerDataMap<C>>): unknown;
  hasCompositeKey(collection: CollectionNames<C>): boolean;
}

export interface ReconciledRemoteEvent<C extends CollectionConfigMap> {
  event?: ChangeBusEvent<SyncHandlerDataMap<C>>;
  needsPush: boolean;
}

/**
 * Reconcile a pulled event with the record's pending local writes. Runs inside the pull
 * transaction, so every read and write goes through `context`. A record without pending
 * writes takes the remote event as is; otherwise the conflict resolver decides, and without
 * one the local state is kept:
 * - `"local"`: skip the remote event; the pending writes are pushed later. The skipped event
 *   is stored for their acknowledgement (see below).
 * - `"remote"`: apply it and drop the pending writes, so they never overwrite it.
 * - `{ data }`: apply the merged data and replace the pending writes with one event that
 *   pushes it: a create when the remote deleted the record, an update otherwise.
 *
 * A push in flight may already hold the replaced writes. Its acknowledgement deletes only the
 * ids it sent, so a merged event stays pending and is pushed after it. What the provider
 * accepted cannot be taken back, though: it lands remotely after the decision and, like any
 * remote write, comes back through pull, where both sides converge on it.
 *
 * Skipped remote events: per record, the store keeps the latest pulled event skipped because
 * the record had pending writes. Those writes may already be on the remote, and the event may
 * be their echo, with server-assigned fields or a concurrent write the server applied after
 * them. Pull will not send it again past the saved checkpoint, so the acknowledgement that
 * leaves the record with no pending writes applies it (`removeFromOutbox`). Pull delivers in
 * server order: when the latest skipped event predates the push, the push's own echo follows
 * and is applied normally over it. Any later remote event of the record replaces it, or
 * removes it once applied or merged. It is written in the pull transaction, so it rolls back
 * with the batch and survives a reload or a leader change with the outbox.
 *
 * `skippedKeys` holds the records (`recordKeyString`) with a stored skipped event; when
 * given, no removal is sent for a record without one, and it is kept up to date.
 *
 * An event with a `rev` is compared with the record's stored revision first:
 * - at or below it: a stale echo, dropped (the pull still saves its checkpoint);
 * - no pending writes: applied, and its `rev` stored;
 * - within the pending writes' numbers: maybe this device's own echo, kept as the skipped
 *   event; the acknowledgement applies it only if its `rev` is above the new stored one;
 * - above them: another device's write, a conflict decided as above, then its `rev` is stored.
 *   `"local"` (or no resolver) applies it and replays the pending writes over it.
 *
 * `pushConflict`: the event is the server state a refused push returned, so it is another
 * device's write whatever its `rev`; one equal to the stored revision was decided already.
 */
export async function reconcileRemoteEvent<C extends CollectionConfigMap>(
  reconciliation: RemoteEventReconciliation<C>,
  event: ChangeBusEvent<SyncHandlerDataMap<C>>,
  context: DBAdapterTransactionContext<C>,
  skippedKeys: Set<string> | undefined,
  pushConflict: boolean,
): Promise<ReconciledRemoteEvent<C>> {
  const collection = event.collection as CollectionNames<C>;
  const key = reconciliation.recordKeyOf(event);
  const { recordId } = key;
  const skippedKey = recordKeyString(key);
  const { store, resolveConflict: resolver } = reconciliation;
  const { native, operations } = context;
  const rememberSkipped = async () => {
    await store.upsertSkippedRemoteEvent({ ...key, event }, native);
    skippedKeys?.add(skippedKey);
  };
  const forgetSkipped = async () => {
    if (skippedKeys && !skippedKeys.delete(skippedKey)) return;
    await store.removeSkippedRemoteEvents([key], native);
  };
  const { rev } = event;
  const storedRev = rev === undefined ? 0 : ((await store.getRevision(key, native)) ?? 0);
  if (rev !== undefined && (pushConflict ? rev === storedRev : rev <= storedRev)) {
    return { needsPush: false };
  }
  const storeRev = async () => {
    if (rev !== undefined) await store.upsertRevision({ ...key, rev }, native);
  };
  const pending = await store.getPendingEvents(key, native);
  if (pending.length === 0) {
    await forgetSkipped();
    await storeRev();
    return { event, needsPush: false };
  }
  if (rev !== undefined && !pushConflict && rev <= storedRev + pending.length) {
    await rememberSkipped();
    return { needsPush: false };
  }

  const keepLocal = async () => {
    if (rev === undefined) {
      await rememberSkipped();
      return { needsPush: false };
    }
    await forgetSkipped();
    await storeRev();
    return { event: replayPending(reconciliation, event, pending), needsPush: false };
  };
  if (!resolver) return keepLocal();
  // A single key is looked up as stored (numeric strings as numbers); a composite one as pulled.
  const localKey = reconciliation.hasCompositeKey(collection)
    ? reconciliation.primaryKeyOf(event)
    : coerceRecordId(recordId);
  const local: SyncHandlerDataMap<C>[CollectionNames<C>]["record"] | undefined =
    operations.getOptional
      ? await operations.getOptional(collection, localKey as never)
      : await operations.get(collection, localKey as never);
  const resolution = await resolver({ remote: event, local });
  if (resolution === "local") return keepLocal();
  // Applied, or merged into the pushed data: the remote state is no longer missing locally.
  await forgetSkipped();
  await storeRev();

  await store.deleteEvents(
    pending.map(({ id }) => id),
    native,
  );
  if (resolution === "remote") return { event, needsPush: false };

  const type = event.type === "delete" ? "create" : "update";
  await store.appendEvents(
    [{ id: crypto.randomUUID(), type, ...key, data: resolution.data, createdAt: Date.now() }],
    native,
  );
  const merged =
    event.type === "delete"
      ? { type, collection: event.collection, data: resolution.data }
      : { ...event, data: resolution.data };
  return { event: merged as ChangeBusEvent<SyncHandlerDataMap<C>>, needsPush: true };
}

/**
 * The local state of a record after a `"local"` decision: the remote event with the pending
 * writes replayed over it. An update has nothing to merge into after a remote delete, so the
 * record stays deleted unless a pending create brings it back.
 */
function replayPending<C extends CollectionConfigMap>(
  reconciliation: RemoteEventReconciliation<C>,
  event: ChangeBusEvent<SyncHandlerDataMap<C>>,
  pending: StoredChangeBusEvent[],
): ChangeBusEvent<SyncHandlerDataMap<C>> {
  let row = event.type === "delete" ? undefined : (event.data as object);
  for (const { type, data } of pending) {
    if (type === "delete") row = undefined;
    else if (type === "create") row = data as object;
    else if (row) row = { ...row, ...(data as object) };
  }
  const { collection, rev } = event;
  if (row) return { type: "update", collection, data: row, rev } as typeof event;
  if (event.type === "delete") return event;
  return {
    type: "delete",
    collection,
    id: reconciliation.primaryKeyOf(event),
    rev,
  } as typeof event;
}
