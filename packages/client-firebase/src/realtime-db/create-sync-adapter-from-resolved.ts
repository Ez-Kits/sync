import {
  PushConflictError,
  type ChangeBusEvent,
  type ChangeBusEventDataMap,
  type CheckpointSerializer,
  type SyncAdapter,
} from "@ez-kits/sync-client-core";
import {
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  onValue,
  get,
  ref,
  update,
  type DataSnapshot,
  type Database,
  type Query,
} from "firebase/database";
import { checkpointMapForCollection } from "../shared/checkpoint.ts";
import {
  isRealtimeDBPermissionDenied,
  realtimeDBPushError,
  rejectedPush,
} from "../shared/push-error.ts";
import { deletedAtFrom, defaultIsDeleted } from "../shared/tombstone.ts";
import type { CollectionKey } from "../shared/types.ts";
import type { ResolvedRealtimeDBSyncAdapterCollectionConfig } from "./types.ts";

/** Target for `onChild*` listeners (collection root or a narrowed RTDB `query`). */
type RealtimeChildListenTarget = ReturnType<typeof ref> | Query;

/** How a child reached the listeners. */
type ChildChangeKind = "added" | "changed" | "removed";

function recordPath(collectionPath: string, recordId: string): string {
  return `${collectionPath}/${recordId}`;
}

function isFieldMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A child's value without its revision field, and the revision held there. */
function splitRevision(
  value: unknown,
  revisionField: string | undefined,
): { raw: unknown; rev: number | undefined } {
  if (revisionField === undefined || !isFieldMap(value)) return { raw: value, rev: undefined };
  const { [revisionField]: revisionValue, ...raw } = value;
  return { raw, rev: typeof revisionValue === "number" ? revisionValue : undefined };
}

/** One child as a pulled change event, by how it changed. */
function toChangeEvent<C extends ChangeBusEventDataMap, N extends CollectionKey<C>, TCheckpoint>(
  collectionConfig: ResolvedRealtimeDBSyncAdapterCollectionConfig<C, N, TCheckpoint>,
  snapshot: DataSnapshot,
  kind: ChildChangeKind,
): ChangeBusEvent<C, N> {
  const collectionName = collectionConfig.collectionName;
  const { raw, rev } = splitRevision(snapshot.val(), collectionConfig.revisionField);
  // A removed child's value is its last known state, not a new revision.
  const revision = rev === undefined || kind === "removed" ? {} : { rev };
  const isDeleted = collectionConfig.isDeleted ?? defaultIsDeleted;
  if (kind === "removed" || isDeleted(raw, { snapshot })) {
    return {
      type: "delete",
      collection: collectionName,
      id: collectionConfig.deserializeDeleteId
        ? collectionConfig.deserializeDeleteId({ snapshot })
        : (snapshot.key as C[N]["delete"]),
      deletedAt:
        collectionConfig.resolveDeletedAt?.(raw, { snapshot }) ??
        deletedAtFrom(raw) ??
        (collectionConfig.revisionField === undefined ? Date.now() : undefined),
      ...revision,
    } as unknown as ChangeBusEvent<C, N>;
  }
  if (kind === "added") {
    const data = collectionConfig.deserializeCreate
      ? collectionConfig.deserializeCreate(raw, { snapshot })
      : (raw as C[N]["create"]);
    return {
      type: "create",
      collection: collectionName,
      data,
      ...revision,
    } as unknown as ChangeBusEvent<C, N>;
  }
  const data = collectionConfig.deserializeUpdate
    ? collectionConfig.deserializeUpdate(raw, { snapshot })
    : (raw as C[N]["update"]);
  return {
    type: "update",
    collection: collectionName,
    data,
    ...revision,
  } as unknown as ChangeBusEvent<C, N>;
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
  /** The revision written, by record path, on collections with revisions. */
  revisions: Map<string, number>;
  events: TEvent[];
}

/** Creates replace the record; updates and deletes merge fields, and non-objects replace it. */
function recordWrite(payload: unknown, merge: boolean): RecordWrite {
  if (merge && isFieldMap(payload)) return { replace: false, fields: { ...payload } };
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
  return { writes: new Map(), ancestors: new Set(), revisions: new Map(), events: [] };
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
  common: { checkpointSerializer?: CheckpointSerializer<TCheckpoint> } = {},
): SyncAdapter<C, N, TCheckpoint> {
  // The revision being written, by record path. The SDK raises child events for a write as soon
  // as it is made, and again if it is refused: until the write settles, a child event of its
  // record is this device's own unconfirmed state, unless it holds a newer revision.
  const writing = new Map<string, number>();

  return {
    // Core only hands this adapter the outbox of these, so nothing it skips piles up.
    collections: collections.map(({ collectionName }) => collectionName),
    checkpointSerializer: common.checkpointSerializer,
    revisionedCollections: collections
      .filter(({ revisionField }) => revisionField !== undefined)
      .map(({ collectionName }) => collectionName),
    pull: (pullOptions) => {
      const { commitChanges, checkpoint: checkpointMap } = pullOptions;
      let stopped = false;
      const unsubscribeFns: Array<() => void> = [];

      for (const collectionConfig of collections) {
        const collectionName = collectionConfig.collectionName;
        const { collectionPath } = collectionConfig;
        const baseRef = ref(db, collectionPath);
        const previousFromStorage = checkpointMap?.[collectionName];
        let previousCheckpoint: TCheckpoint | undefined = previousFromStorage;

        const listenTarget: RealtimeChildListenTarget =
          collectionConfig.buildPullQuery?.({
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

        // The SDK raises the child events of one server message in a single loop, so events
        // gathered until the next microtask commit together (a first pull in one go).
        let pending: ChangeBusEvent<C, N>[] = [];
        let pendingCheckpoint: TCheckpoint | undefined;
        const flush = () => {
          if (pending.length === 0) return;
          const changes = pending;
          pending = [];
          commitChanges({
            changes,
            checkpoint: checkpointMapForCollection(
              collectionName,
              pendingCheckpoint as TCheckpoint,
            ),
          });
        };
        const queue = (event: ChangeBusEvent<C, N>, snapshot: DataSnapshot) => {
          if (pending.length === 0) queueMicrotask(flush);
          pending.push(event);
          pendingCheckpoint = nextCp(snapshot);
        };
        const queueChild = (kind: ChildChangeKind) => (snapshot: DataSnapshot) => {
          const writingRev = writing.get(recordPath(collectionPath, snapshot.key as string));
          if (writingRev !== undefined) {
            const { rev } = splitRevision(snapshot.val(), collectionConfig.revisionField);
            if (rev === undefined || rev <= writingRev) return;
          }
          queue(toChangeEvent(collectionConfig, snapshot, kind), snapshot);
        };

        const listen = () => {
          if (stopped) return;
          const unsubscribeAdded = onChildAdded(listenTarget, queueChild("added"), (error: Error) =>
            pullOptions.onError?.(error),
          );

          const unsubscribeChanged = onChildChanged(
            listenTarget,
            queueChild("changed"),
            (error: Error) => pullOptions.onError?.(error),
          );

          const unsubscribeRemoved = onChildRemoved(
            listenTarget,
            queueChild("removed"),
            (error: Error) => pullOptions.onError?.(error),
          );

          // A value event fires after the child events of the data it holds: the children
          // existing when the listeners opened were all delivered. They are committed first,
          // so core reports caught up behind them.
          const unsubscribeLoaded = onValue(
            listenTarget,
            () => {
              flush();
              pullOptions.onCaughtUp?.([collectionName]);
            },
            (error: Error) => pullOptions.onError?.(error),
            { onlyOnce: true },
          );

          // The modular SDK returns an unsubscribe function, not the callback `off` matches.
          unsubscribeFns.push(
            unsubscribeAdded,
            unsubscribeChanged,
            unsubscribeRemoved,
            unsubscribeLoaded,
          );
        };

        const firstPull = previousFromStorage === undefined;
        const count = collectionConfig.countInitialPull;
        if (firstPull && count) {
          Promise.resolve()
            .then(() => count({ db, collectionPath }))
            .then(
              (total) => {
                if (!stopped && Number.isFinite(total)) {
                  pullOptions.onCount?.({ collection: collectionName, total });
                }
              },
              // Progress only: the pull goes on without a total.
              () => undefined,
            );
        }

        const buildPreview = collectionConfig.buildPreviewQuery;
        if (!firstPull || !buildPreview) {
          listen();
          continue;
        }
        // The listeners open once the preview is queued, so the preview never lands after
        // (and over) newer children they delivered.
        void (async () => {
          try {
            const snapshot = await get(buildPreview({ db, collectionPath }));
            if (stopped) return;
            const changes: ChangeBusEvent<C, N>[] = [];
            snapshot.forEach((child) => {
              changes.push(toChangeEvent(collectionConfig, child, "added"));
            });
            commitChanges({ changes, checkpoint: {}, preview: true });
            pullOptions.onPreviewed?.({
              collection: collectionName,
              hasData: changes.some((change) => change.type !== "delete"),
            });
          } catch {
            // Offline or refused: the full pull shows the rows instead.
          } finally {
            listen();
          }
        })();
      }

      return () => {
        stopped = true;
        for (const unsubscribe of unsubscribeFns) unsubscribe();
      };
    },
    push: async ({ events, commitChanges }) => {
      const collectionByName = new Map(
        collections.map((collectionConfig) => [collectionConfig.collectionName, collectionConfig]),
      );

      /**
       * After rules refused an update: a `PushConflictError` with the server state of its
       * records another device wrote first (their revision is not the one this push built on).
       */
      const findPushConflict = async (updateEvents: ChangeBusEvent<C, N>[]) => {
        const serverEvents = await Promise.all(
          updateEvents.map(async (event) => {
            const collectionConfig = collectionByName.get(event.collection as N)!;
            const { collectionPath, revisionField } = collectionConfig;
            if (revisionField === undefined) return undefined;
            const snapshot = await get(
              ref(db, recordPath(collectionPath, collectionConfig.resolveRemoteId(event))),
            );
            const serverRev = splitRevision(snapshot.val(), revisionField).rev ?? 0;
            if (serverRev === event.rev! - 1) return undefined;
            return {
              ...toChangeEvent(
                collectionConfig,
                snapshot,
                snapshot.exists() ? "changed" : "removed",
              ),
              rev: serverRev,
            };
          }),
        );
        const conflicts = serverEvents.filter((event) => event !== undefined);
        return conflicts.length > 0 ? new PushConflictError(conflicts) : undefined;
      };

      // Events are coalesced per record, in outbox order, into as few multipath updates as
      // possible: one update must not hold a path and one of its descendants. Security rules
      // check an update against the data before it, and each revision must follow the last, so
      // a record with revisions is written once per update instead of coalesced.
      const pendingUpdates: PendingUpdate<ChangeBusEvent<C, N>>[] = [];
      let current = createPendingUpdate<ChangeBusEvent<C, N>>();

      for (const event of events) {
        const collectionConfig = collectionByName.get(event.collection as N);
        if (!collectionConfig) continue;

        const { collectionPath, revisionField } = collectionConfig;
        const recordId = collectionConfig.resolveRemoteId(event as ChangeBusEvent<C, N>);
        const path = recordPath(collectionPath, recordId);
        // A value that cannot hold a field goes without a revision, for the rules to refuse.
        const withRevision = (payload: unknown): unknown =>
          revisionField !== undefined && isFieldMap(payload)
            ? { ...payload, [revisionField]: event.rev }
            : payload;
        let write: RecordWrite;

        if (event.type === "delete") {
          const deletedAt = event.deletedAt ?? Date.now();
          const payload = collectionConfig.serializeDelete
            ? collectionConfig.serializeDelete(event.id as C[N]["delete"], { deletedAt })
            : revisionField === undefined
              ? { deleted: true, deletedAt }
              : { deleted: true };
          write = recordWrite(withRevision(payload), true);
        } else if (event.type === "create") {
          const payload = collectionConfig.serializeCreate
            ? collectionConfig.serializeCreate(event.data as C[N]["create"])
            : event.data;
          write = recordWrite(withRevision(payload), false);
        } else {
          const payload = collectionConfig.serializeUpdate
            ? collectionConfig.serializeUpdate(event.data as C[N]["update"])
            : event.data;
          write = recordWrite(withRevision(payload), true);
        }

        const revisionedAgain = revisionField !== undefined && current.writes.has(path);
        if (revisionedAgain || !addRecordWrite(current, path, write)) {
          pendingUpdates.push(current);
          current = createPendingUpdate();
          addRecordWrite(current, path, write);
        }
        if (revisionField !== undefined) current.revisions.set(path, event.rev!);
        current.events.push(event as ChangeBusEvent<C, N>);
      }
      if (current.events.length > 0) pendingUpdates.push(current);

      // Updates are written in order, and each is acknowledged once written, so a failure
      // leaves only the remaining events in the outbox. An update is atomic: when one write
      // is refused for good, core narrows the push down to it. An update refused because
      // another device wrote one of its records first goes to conflict resolution.
      for (const pending of pendingUpdates) {
        const updates = toMultipathUpdates(pending.writes);
        if (Object.keys(updates).length > 0) {
          for (const [path, rev] of pending.revisions) writing.set(path, rev);
          try {
            await writeUpdate(db, updates).finally(() => {
              for (const path of pending.revisions.keys()) writing.delete(path);
            });
          } catch (error) {
            if (isRealtimeDBPermissionDenied(error)) {
              // Unreadable records leave the refusal standing; its parked retry looks again.
              const conflict = await findPushConflict(pending.events).catch(() => undefined);
              if (conflict) throw conflict;
            }
            throw error;
          }
        }
        await commitChanges({ events: pending.events });
      }
    },
  };
}
