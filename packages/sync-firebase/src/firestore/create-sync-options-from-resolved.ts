import type { ChangeBusEvent, ChangeBusEventDataMap, SyncOptions } from "@ez-kits/sync-client-core";
import {
  collection as getCollectionRef,
  doc,
  onSnapshot,
  query,
  setDoc,
  type CollectionReference,
  type DocumentData,
  type Firestore,
  type Query,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { checkpointMapForCollection } from "../shared/checkpoint.ts";
import type { CollectionKey } from "../shared/types.ts";
import type { ResolvedFirestoreCollectionSync } from "./types.ts";

function getSnapshotData(snapshot: QueryDocumentSnapshot<DocumentData>): DocumentData {
  return snapshot.data() ?? {};
}

function defaultIsDeleted(data: DocumentData): boolean {
  return data.deleted === true;
}

function buildPullSource(
  collectionRef: CollectionReference<DocumentData>,
  constraints: QueryConstraint[],
): CollectionReference<DocumentData> | Query<DocumentData> {
  if (constraints.length === 0) return collectionRef;
  return query(collectionRef, ...constraints);
}

export function createFirestoreSyncOptionsFromResolved<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
>(
  db: Firestore,
  collections: readonly ResolvedFirestoreCollectionSync<C, N, TCheckpoint>[],
  common: { includeMetadataChanges?: boolean } = {},
): SyncOptions<C, N, TCheckpoint> {
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

        return onSnapshot(pullSource, { includeMetadataChanges }, (snapshot) => {
          const changes = snapshot.docChanges().map((change) => {
            if (change.type === "removed") {
              const id = collectionConfig.deserializeDeleteId
                ? collectionConfig.deserializeDeleteId({
                    snapshot: change.doc,
                  })
                : (change.doc.id as C[N]["delete"]);
              return {
                type: "delete",
                collection: collectionName,
                id,
              } as unknown as ChangeBusEvent<C, N>;
            }

            const raw = getSnapshotData(change.doc);
            if (isDeleted(raw, { snapshot: change.doc })) {
              const id = collectionConfig.deserializeDeleteId
                ? collectionConfig.deserializeDeleteId({
                    snapshot: change.doc,
                  })
                : (change.doc.id as C[N]["delete"]);
              return {
                type: "delete",
                collection: collectionName,
                id,
              } as unknown as ChangeBusEvent<C, N>;
            }

            if (change.type === "added") {
              const data = collectionConfig.deserializeCreate
                ? collectionConfig.deserializeCreate(raw, {
                    snapshot: change.doc,
                  })
                : (raw as C[N]["create"]);
              return {
                type: "create",
                collection: collectionName,
                data,
              } as unknown as ChangeBusEvent<C, N>;
            }

            const data = collectionConfig.deserializeUpdate
              ? collectionConfig.deserializeUpdate(raw, {
                  snapshot: change.doc,
                })
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
        });
      });

      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
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
            : ({
                deleted: true,
                deletedAt: Date.now(),
              } satisfies DocumentData);
          await setDoc(doc(db, collectionPath, String(event.id)), payload, { merge: true });
          continue;
        }

        const id = collectionConfig.resolveDocumentId
          ? collectionConfig.resolveDocumentId(event as ChangeBusEvent<C, N>)
          : String((event.data as { id?: string | number }).id ?? crypto.randomUUID());

        if (event.type === "create") {
          const payload = collectionConfig.serializeCreate
            ? collectionConfig.serializeCreate(event.data as C[N]["create"])
            : (event.data as DocumentData);
          await setDoc(doc(db, collectionPath, id), payload);
          continue;
        }

        const payload = collectionConfig.serializeUpdate
          ? collectionConfig.serializeUpdate(event.data as C[N]["update"])
          : (event.data as DocumentData);
        await setDoc(doc(db, collectionPath, id), payload, {
          merge: true,
        });
      }

      commitChanges({ events });
    },
  };
}
