import type { ChangeBusEvent, ChangeBusEventDataMap, SyncOptions } from "@ez-kits/sync-client-core";
import {
  child,
  off,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  ref,
  set,
  update,
  type DataSnapshot,
  type Database,
  type Query,
} from "firebase/database";
import { checkpointMapForCollection } from "../shared/checkpoint.ts";
import type { CollectionKey } from "../shared/types.ts";
import type { ResolvedRealtimeDBCollectionSync } from "./types.ts";

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

export function createRealtimeDBSyncOptionsFromResolved<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
>(
  db: Database,
  collections: readonly ResolvedRealtimeDBCollectionSync<C, N, TCheckpoint>[],
): SyncOptions<C, N, TCheckpoint> {
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

        const addedHandler = onChildAdded(listenTarget, (snapshot) => {
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
        });

        const changedHandler = onChildChanged(listenTarget, (snapshot) => {
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
        });

        const removedHandler = onChildRemoved(listenTarget, (snapshot) => {
          const id = collectionConfig.deserializeDeleteId
            ? collectionConfig.deserializeDeleteId({ snapshot })
            : (snapshot.key as C[N]["delete"]);
          commitChanges({
            changes: [
              {
                type: "delete",
                collection: collectionName,
                id,
              } as unknown as ChangeBusEvent<C, N>,
            ],
            checkpoint: checkpointMapForCollection(collectionName, nextCp(snapshot)),
          });
        });

        unsubscribeFns.push(
          () => off(listenTarget, "child_added", addedHandler),
          () => off(listenTarget, "child_changed", changedHandler),
          () => off(listenTarget, "child_removed", removedHandler),
        );
      }

      return () => {
        for (const unsubscribe of unsubscribeFns) unsubscribe();
      };
    },
    push: async ({ events, commitChanges }) => {
      const collectionByName = new Map(
        collections.map((collectionConfig) => [collectionConfig.collectionName, collectionConfig]),
      );

      for (const event of events) {
        const collectionConfig = collectionByName.get(event.collection as N);
        if (!collectionConfig) continue;

        const { collectionPath } = collectionConfig;

        if (event.type === "delete") {
          const payload = collectionConfig.serializeDelete
            ? collectionConfig.serializeDelete(event.id as C[N]["delete"])
            : {
                deleted: true,
                deletedAt: Date.now(),
              };
          await update(
            child(ref(db, collectionPath), String(event.id)),
            payload as Record<string, unknown>,
          );
          continue;
        }

        const recordId = collectionConfig.resolveRecordId
          ? collectionConfig.resolveRecordId(event as ChangeBusEvent<C, N>)
          : String((event.data as { id?: string | number }).id ?? crypto.randomUUID());
        const nodeRef = child(ref(db, collectionPath), recordId);

        if (event.type === "create") {
          const payload = collectionConfig.serializeCreate
            ? collectionConfig.serializeCreate(event.data as C[N]["create"])
            : event.data;
          await set(nodeRef, payload);
          continue;
        }

        const payload = collectionConfig.serializeUpdate
          ? collectionConfig.serializeUpdate(event.data as C[N]["update"])
          : event.data;
        await update(nodeRef, payload as Record<string, unknown>);
      }

      commitChanges({ events });
    },
  };
}
