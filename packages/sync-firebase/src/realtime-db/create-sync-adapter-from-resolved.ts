import type { ChangeBusEvent, ChangeBusEventDataMap, SyncAdapter } from "@ez-kits/sync-client-core";
import {
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  ref,
  update,
  type DataSnapshot,
  type Database,
  type Query,
} from "firebase/database";
import { checkpointMapForCollection } from "../shared/checkpoint.ts";
import { realtimeDBPushError, rejectedPush } from "../shared/push-error.ts";
import type { CollectionKey } from "../shared/types.ts";
import type { ResolvedRealtimeDBSyncAdapterCollectionConfig } from "./types.ts";

/** Target for `onChild*` listeners (collection root or a narrowed RTDB `query`). */
type RealtimeChildListenTarget = ReturnType<typeof ref> | Query;

function defaultIsDeleted(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    "deleted" in data &&
    (data as { deleted?: unknown }).deleted === true
  );
}

function deletedAtFrom(data: unknown): number {
  if (
    typeof data === "object" &&
    data !== null &&
    "deletedAt" in data &&
    typeof data.deletedAt === "number" &&
    Number.isFinite(data.deletedAt)
  ) {
    return data.deletedAt;
  }
  return Date.now();
}

function recordPath(collectionPath: string, recordId: string): string {
  return `${collectionPath}/${recordId}`;
}

/**
 * The net write to one record: replace the whole node, or merge fields into it
 * (`path/field` keys, matching `update(nodeRef, fields)`).
 */
type RecordWrite =
  | { replace: true; value: unknown }
  | { replace: false; fields: Record<string, unknown> };

/** One multipath `update` and the events it applies. */
interface PendingUpdate<TEvent> {
  writes: Map<string, RecordWrite>;
  /** Strict ancestors of the record paths in {@link writes}. */
  ancestors: Set<string>;
  events: TEvent[];
}

/** Creates replace the record; updates and deletes merge fields, and non-objects replace it. */
function recordWrite(payload: unknown, merge: boolean): RecordWrite {
  if (merge && typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return { replace: false, fields: { ...(payload as Record<string, unknown>) } };
  }
  return { replace: true, value: payload };
}

function hasDeepPath(fields: Record<string, unknown>): boolean {
  return Object.keys(fields).some((field) => field.includes("/"));
}

/**
 * Fold `next` into the record's `previous` write, with the effect of applying both in order.
 * Returns undefined when they cannot share one update.
 */
function coalesceWrite(previous: RecordWrite, next: RecordWrite): RecordWrite | undefined {
  if (next.replace) return next;
  // A slash in a field writes a deeper path, which would overlap the record's other keys.
  if (hasDeepPath(next.fields) || (!previous.replace && hasDeepPath(previous.fields))) {
    return undefined;
  }
  if (!previous.replace) return { replace: false, fields: { ...previous.fields, ...next.fields } };
  // Merging into a primitive replaces it, as RTDB does when a child is written under it.
  const base = typeof previous.value === "object" && previous.value !== null ? previous.value : {};
  return { replace: true, value: { ...base, ...next.fields } };
}

function ancestorPaths(path: string): string[] {
  const segments = path.split("/");
  return segments.slice(1).map((_, index) => segments.slice(0, index + 1).join("/"));
}

/**
 * Add a record write to `pending`, coalesced with an earlier write of the same record.
 * Returns false when it cannot join without two of the update's paths nesting, which the
 * SDK rejects (e.g. a record id containing `/`).
 */
function addRecordWrite<TEvent>(
  pending: PendingUpdate<TEvent>,
  path: string,
  write: RecordWrite,
): boolean {
  const previous = pending.writes.get(path);
  if (previous) {
    const coalesced = coalesceWrite(previous, write);
    if (!coalesced) return false;
    pending.writes.set(path, coalesced);
    return true;
  }
  const ancestors = ancestorPaths(path);
  if (pending.ancestors.has(path) || ancestors.some((ancestor) => pending.writes.has(ancestor))) {
    return false;
  }
  for (const ancestor of ancestors) pending.ancestors.add(ancestor);
  pending.writes.set(path, write);
  return true;
}

function toMultipathUpdates(writes: Map<string, RecordWrite>): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  for (const [path, write] of writes) {
    if (write.replace) {
      updates[path] = write.value;
      continue;
    }
    for (const [field, value] of Object.entries(write.fields)) updates[`${path}/${field}`] = value;
  }
  return updates;
}

function createPendingUpdate<TEvent>(): PendingUpdate<TEvent> {
  return { writes: new Map(), ancestors: new Set(), events: [] };
}

async function writeUpdate(db: Database, updates: Record<string, unknown>): Promise<void> {
  let written: Promise<void>;
  try {
    // The SDK validates keys and values (no `undefined`, no `.`/`#`/`$`/`[`/`]` in keys)
    // synchronously, before sending: an update that throws here always will.
    written = update(ref(db), updates);
  } catch (error) {
    throw rejectedPush("Realtime Database", error);
  }
  try {
    await written;
  } catch (error) {
    throw realtimeDBPushError(error);
  }
}

export function createRealtimeDBSyncAdapterFromResolved<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
>(
  db: Database,
  collections: readonly ResolvedRealtimeDBSyncAdapterCollectionConfig<C, N, TCheckpoint>[],
): SyncAdapter<C, N, TCheckpoint> {
  return {
    pull: (pullOptions) => {
      const { commitChanges, checkpoint: checkpointMap } = pullOptions;
      const unsubscribeFns: Array<() => void> = [];

      for (const collectionConfig of collections) {
        const collectionName = collectionConfig.collectionName;
        const { collectionPath } = collectionConfig;
        const baseRef = ref(db, collectionPath);
        const previousFromStorage = checkpointMap?.[collectionName];
        let previousCheckpoint: TCheckpoint | undefined = previousFromStorage;
        const isDeleted = collectionConfig.isDeleted ?? defaultIsDeleted;

        const listenTarget: RealtimeChildListenTarget =
          collectionConfig.buildRealtimePullQuery?.({
            db,
            collectionPath,
            checkpoint: previousFromStorage,
          }) ?? baseRef;

        const nextCp = (snapshot: DataSnapshot) => {
          const nextCheckpoint =
            collectionConfig.createPullCheckpoint?.({
              snapshot,
              previousCheckpoint,
            }) ?? collectionConfig.createCheckpoint();
          previousCheckpoint = nextCheckpoint;
          return nextCheckpoint;
        };

        const unsubscribeAdded = onChildAdded(
          listenTarget,
          (snapshot) => {
            const raw = snapshot.val();
            if (isDeleted(raw, { snapshot })) {
              const id = collectionConfig.deserializeDeleteId
                ? collectionConfig.deserializeDeleteId({ snapshot })
                : (snapshot.key as C[N]["delete"]);
              commitChanges({
                changes: [
                  {
                    type: "delete",
                    collection: collectionName,
                    id,
                    deletedAt:
                      collectionConfig.resolveDeletedAt?.(raw, { snapshot }) ?? deletedAtFrom(raw),
                  } as unknown as ChangeBusEvent<C, N>,
                ],
                checkpoint: checkpointMapForCollection(collectionName, nextCp(snapshot)),
              });
              return;
            }
            const data = collectionConfig.deserializeCreate
              ? collectionConfig.deserializeCreate(raw, { snapshot })
              : (raw as C[N]["create"]);
            commitChanges({
              changes: [
                {
                  type: "create",
                  collection: collectionName,
                  data,
                } as unknown as ChangeBusEvent<C, N>,
              ],
              checkpoint: checkpointMapForCollection(collectionName, nextCp(snapshot)),
            });
          },
          (error: Error) => pullOptions.onError?.(error),
        );

        const unsubscribeChanged = onChildChanged(
          listenTarget,
          (snapshot) => {
            const raw = snapshot.val();
            if (isDeleted(raw, { snapshot })) {
              const id = collectionConfig.deserializeDeleteId
                ? collectionConfig.deserializeDeleteId({ snapshot })
                : (snapshot.key as C[N]["delete"]);
              commitChanges({
                changes: [
                  {
                    type: "delete",
                    collection: collectionName,
                    id,
                    deletedAt:
                      collectionConfig.resolveDeletedAt?.(raw, { snapshot }) ?? deletedAtFrom(raw),
                  } as unknown as ChangeBusEvent<C, N>,
                ],
                checkpoint: checkpointMapForCollection(collectionName, nextCp(snapshot)),
              });
              return;
            }
            const data = collectionConfig.deserializeUpdate
              ? collectionConfig.deserializeUpdate(raw, { snapshot })
              : (raw as C[N]["update"]);
            commitChanges({
              changes: [
                {
                  type: "update",
                  collection: collectionName,
                  data,
                } as unknown as ChangeBusEvent<C, N>,
              ],
              checkpoint: checkpointMapForCollection(collectionName, nextCp(snapshot)),
            });
          },
          (error: Error) => pullOptions.onError?.(error),
        );

        const unsubscribeRemoved = onChildRemoved(
          listenTarget,
          (snapshot) => {
            const id = collectionConfig.deserializeDeleteId
              ? collectionConfig.deserializeDeleteId({ snapshot })
              : (snapshot.key as C[N]["delete"]);
            const raw = snapshot.val();
            const deletedAt =
              collectionConfig.resolveDeletedAt?.(raw, { snapshot }) ?? deletedAtFrom(raw);
            commitChanges({
              changes: [
                {
                  type: "delete",
                  collection: collectionName,
                  id,
                  deletedAt,
                } as unknown as ChangeBusEvent<C, N>,
              ],
              checkpoint: checkpointMapForCollection(collectionName, nextCp(snapshot)),
            });
          },
          (error: Error) => pullOptions.onError?.(error),
        );

        // The modular SDK returns an unsubscribe function, not the callback `off` matches.
        unsubscribeFns.push(unsubscribeAdded, unsubscribeChanged, unsubscribeRemoved);
      }

      return () => {
        for (const unsubscribe of unsubscribeFns) unsubscribe();
      };
    },
    push: async ({ events, commitChanges }) => {
      const collectionByName = new Map(
        collections.map((collectionConfig) => [collectionConfig.collectionName, collectionConfig]),
      );

      // Events are coalesced per record, in outbox order, into as few multipath updates as
      // possible: one update must not hold a path and one of its descendants.
      const pendingUpdates: PendingUpdate<ChangeBusEvent<C, N>>[] = [];
      let current = createPendingUpdate<ChangeBusEvent<C, N>>();

      for (const event of events) {
        const collectionConfig = collectionByName.get(event.collection as N);
        if (!collectionConfig) continue;

        const recordId = collectionConfig.resolveRecordId(event as ChangeBusEvent<C, N>);
        const path = recordPath(collectionConfig.collectionPath, recordId);
        let write: RecordWrite;

        if (event.type === "delete") {
          const deletedAt = event.deletedAt ?? Date.now();
          const payload = collectionConfig.serializeDelete
            ? collectionConfig.serializeDelete(event.id as C[N]["delete"], { deletedAt })
            : {
                deleted: true,
                deletedAt,
              };
          write = recordWrite(payload, true);
        } else if (event.type === "create") {
          const payload = collectionConfig.serializeCreate
            ? collectionConfig.serializeCreate(event.data as C[N]["create"])
            : event.data;
          write = recordWrite(payload, false);
        } else {
          const payload = collectionConfig.serializeUpdate
            ? collectionConfig.serializeUpdate(event.data as C[N]["update"])
            : event.data;
          write = recordWrite(payload, true);
        }

        if (!addRecordWrite(current, path, write)) {
          pendingUpdates.push(current);
          current = createPendingUpdate();
          addRecordWrite(current, path, write);
        }
        current.events.push(event as ChangeBusEvent<C, N>);
      }
      if (current.events.length > 0) pendingUpdates.push(current);

      // Updates are written in order, and each is acknowledged once written, so a failure
      // leaves only the remaining events in the outbox. An update is atomic: when one write
      // is refused for good, core narrows the push down to it.
      for (const pending of pendingUpdates) {
        const updates = toMultipathUpdates(pending.writes);
        if (Object.keys(updates).length > 0) await writeUpdate(db, updates);
        await commitChanges({ events: pending.events });
      }
    },
  };
}
