import type { ChangeBusEvent, ChangeBusEventDataMap, SyncAdapter } from "@ez-kits/sync-client-core";
import {
  doc,
  collection as getCollectionRef,
  onSnapshot,
  query,
  writeBatch,
  type CollectionReference,
  type DocumentData,
  type Firestore,
  type Query,
  type QueryConstraint,
  type QueryDocumentSnapshot,
  type WriteBatch,
} from "firebase/firestore";
import { checkpointMapForCollection } from "../shared/checkpoint.ts";
import type { CollectionKey } from "../shared/types.ts";
import type { ResolvedFirestoreSyncAdapterCollectionConfig } from "./types.ts";

/** Firestore allows at most 500 writes per batch. */
const FIRESTORE_BATCH_LIMIT = 500;

function getSnapshotData(snapshot: QueryDocumentSnapshot<DocumentData>): DocumentData {
  return snapshot.data() ?? {};
}

function defaultIsDeleted(data: DocumentData): boolean {
  return data.deleted === true;
}

function deletedAtFrom(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "toMillis" in value &&
    typeof value.toMillis === "function"
  ) {
    return value.toMillis();
  }
  return Date.now();
}

function buildPullSource(
  collectionRef: CollectionReference<DocumentData>,
  constraints: QueryConstraint[],
): CollectionReference<DocumentData> | Query<DocumentData> {
  if (constraints.length === 0) return collectionRef;
  return query(collectionRef, ...constraints);
}

export function createFirestoreSyncAdapterFromResolved<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
>(
  db: Firestore,
  collections: readonly ResolvedFirestoreSyncAdapterCollectionConfig<C, N, TCheckpoint>[],
  common: { includeMetadataChanges?: boolean } = {},
): SyncAdapter<C, N, TCheckpoint> {
  return {
    pull: (pullOptions) => {
      const { commitChanges, checkpoint: checkpointMap } = pullOptions;
      const unsubscribes = collections.map((collectionConfig) => {
        const collectionName = collectionConfig.collectionName;
        const collectionRef = getCollectionRef(db, collectionConfig.collectionPath);
        const previousFromStorage = checkpointMap?.[collectionName];
        let previousCheckpoint: TCheckpoint | undefined = previousFromStorage;
        const isDeleted = collectionConfig.isDeleted ?? defaultIsDeleted;

        const constraints =
          collectionConfig.buildPullQueryConstraints?.({
            checkpoint: previousFromStorage,
          }) ?? [];

        const pullSource = buildPullSource(collectionRef, constraints);
        const includeMetadataChanges =
          collectionConfig.includeMetadataChanges ?? common.includeMetadataChanges ?? false;

        return onSnapshot(
          pullSource,
          { includeMetadataChanges },
          (snapshot) => {
            const changes = snapshot.docChanges().map((change) => {
              if (change.type === "removed") {
                const raw = getSnapshotData(change.doc);
                const id = collectionConfig.deserializeDeleteId
                  ? collectionConfig.deserializeDeleteId({ snapshot: change.doc })
                  : (change.doc.id as C[N]["delete"]);
                return {
                  type: "delete",
                  collection: collectionName,
                  id,
                  deletedAt:
                    collectionConfig.resolveDeletedAt?.(raw, { snapshot: change.doc }) ??
                    deletedAtFrom(raw.deletedAt),
                } as unknown as ChangeBusEvent<C, N>;
              }

              const raw = getSnapshotData(change.doc);
              if (isDeleted(raw, { snapshot: change.doc })) {
                const id = collectionConfig.deserializeDeleteId
                  ? collectionConfig.deserializeDeleteId({ snapshot: change.doc })
                  : (change.doc.id as C[N]["delete"]);
                return {
                  type: "delete",
                  collection: collectionName,
                  id,
                  deletedAt:
                    collectionConfig.resolveDeletedAt?.(raw, { snapshot: change.doc }) ??
                    deletedAtFrom(raw.deletedAt),
                } as unknown as ChangeBusEvent<C, N>;
              }

              if (change.type === "added") {
                const data = collectionConfig.deserializeCreate
                  ? collectionConfig.deserializeCreate(raw, { snapshot: change.doc })
                  : (raw as C[N]["create"]);
                return {
                  type: "create",
                  collection: collectionName,
                  data,
                } as unknown as ChangeBusEvent<C, N>;
              }

              const data = collectionConfig.deserializeUpdate
                ? collectionConfig.deserializeUpdate(raw, { snapshot: change.doc })
                : (raw as C[N]["update"]);
              return {
                type: "update",
                collection: collectionName,
                data,
              } as unknown as ChangeBusEvent<C, N>;
            });

            if (changes.length > 0) {
              const nextCheckpoint =
                collectionConfig.createPullCheckpoint?.({
                  snapshot,
                  previousCheckpoint,
                }) ?? collectionConfig.createCheckpoint();
              previousCheckpoint = nextCheckpoint;
              commitChanges({
                changes,
                checkpoint: checkpointMapForCollection(collectionName, nextCheckpoint),
              });
            }
          },
          (error: Error) => pullOptions.onError?.(error),
        );
      });

      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    push: async ({ events, commitChanges }) => {
      const collectionByName = new Map(
        collections.map((collectionConfig) => [collectionConfig.collectionName, collectionConfig]),
      );

      // Each event is one write. Writes to one document, in a batch or across batches committed
      // in order, apply in event order, so events need no coalescing.
      const batches: Array<{ batch: WriteBatch; events: ChangeBusEvent<C, N>[] }> = [];
      let current = { batch: writeBatch(db), events: [] as ChangeBusEvent<C, N>[] };

      const enqueueSet = (
        event: ChangeBusEvent<C, N>,
        documentPath: string,
        documentId: string,
        payload: DocumentData,
        options?: { merge: boolean },
      ) => {
        if (current.events.length >= FIRESTORE_BATCH_LIMIT) {
          batches.push(current);
          current = { batch: writeBatch(db), events: [] };
        }
        const ref = doc(db, documentPath, documentId);
        if (options) {
          current.batch.set(ref, payload, options);
        } else {
          current.batch.set(ref, payload);
        }
        current.events.push(event);
      };

      for (const rawEvent of events) {
        const collectionConfig = collectionByName.get(rawEvent.collection as N);
        if (!collectionConfig) continue;
        const event = rawEvent as ChangeBusEvent<C, N>;

        const { collectionPath } = collectionConfig;
        const id = collectionConfig.resolveDocumentId(event);

        if (event.type === "delete") {
          const deletedAt = event.deletedAt ?? Date.now();
          const payload = collectionConfig.serializeDelete
            ? collectionConfig.serializeDelete(event.id as C[N]["delete"], { deletedAt })
            : ({
                deleted: true,
                deletedAt,
              } satisfies DocumentData);
          enqueueSet(event, collectionPath, id, payload, { merge: true });
          continue;
        }

        if (event.type === "create") {
          const payload = collectionConfig.serializeCreate
            ? collectionConfig.serializeCreate(event.data as C[N]["create"])
            : (event.data as DocumentData);
          enqueueSet(event, collectionPath, id, payload);
          continue;
        }

        const payload = collectionConfig.serializeUpdate
          ? collectionConfig.serializeUpdate(event.data as C[N]["update"])
          : (event.data as DocumentData);
        enqueueSet(event, collectionPath, id, payload, { merge: true });
      }
      if (current.events.length > 0) batches.push(current);

      // Batches commit in order, and each is acknowledged before the next commits, so a
      // failed batch leaves only its own and later events in the outbox.
      for (const { batch, events: batchEvents } of batches) {
        await batch.commit();
        await commitChanges({ events: batchEvents });
      }
    },
  };
}
