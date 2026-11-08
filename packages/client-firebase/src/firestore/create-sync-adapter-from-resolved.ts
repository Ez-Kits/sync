import {
  PushConflictError,
  type ChangeBusEvent,
  type ChangeBusEventDataMap,
  type CheckpointSerializer,
  type SyncAdapter,
} from "@ez-kits/sync-client-core";
import {
  doc,
  collection as getCollectionRef,
  getCountFromServer,
  getDocFromServer,
  getDocsFromServer,
  onSnapshot,
  query,
  writeBatch,
  type CollectionReference,
  type DocumentChangeType,
  type DocumentData,
  type Firestore,
  type Query,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { checkpointMapForCollection } from "../shared/checkpoint.ts";
import { firestorePushError, isFirestorePermissionDenied } from "../shared/push-error.ts";
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

/** The revision in a document's field; anything but a number is no revision. */
function revisionFrom(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function buildPullSource(
  collectionRef: CollectionReference<DocumentData>,
  constraints: QueryConstraint[],
): CollectionReference<DocumentData> | Query<DocumentData> {
  if (constraints.length === 0) return collectionRef;
  return query(collectionRef, ...constraints);
}

/** One snapshot document as a pulled change event, by how it changed (`DocumentChangeType`). */
function toChangeEvent<C extends ChangeBusEventDataMap, N extends CollectionKey<C>, TCheckpoint>(
  collectionConfig: ResolvedFirestoreSyncAdapterCollectionConfig<C, N, TCheckpoint>,
  snapshot: QueryDocumentSnapshot<DocumentData>,
  kind: DocumentChangeType,
): ChangeBusEvent<C, N> {
  const collectionName = collectionConfig.collectionName;
  const { [collectionConfig.revisionField ?? ""]: revisionValue, ...raw } =
    getSnapshotData(snapshot);
  // A removed document's data is its last known state, not a new revision.
  const rev = kind === "removed" ? undefined : revisionFrom(revisionValue);
  const revision = rev === undefined ? {} : { rev };
  const isDeleted = collectionConfig.isDeleted ?? defaultIsDeleted;
  if (kind === "removed" || isDeleted(raw, { snapshot })) {
    const id = collectionConfig.deserializeDeleteId
      ? collectionConfig.deserializeDeleteId({ snapshot })
      : (snapshot.id as C[N]["delete"]);
    return {
      type: "delete",
      collection: collectionName,
      id,
      deletedAt:
        collectionConfig.resolveDeletedAt?.(raw, { snapshot }) ?? deletedAtFrom(raw.deletedAt),
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

export function createFirestoreSyncAdapterFromResolved<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
>(
  db: Firestore,
  collections: readonly ResolvedFirestoreSyncAdapterCollectionConfig<C, N, TCheckpoint>[],
  common: {
    includeMetadataChanges?: boolean;
    checkpointSerializer?: CheckpointSerializer<TCheckpoint>;
  } = {},
): SyncAdapter<C, N, TCheckpoint> {
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
      const unsubscribes: Array<() => void> = [];

      for (const collectionConfig of collections) {
        const collectionName = collectionConfig.collectionName;
        const collectionRef = getCollectionRef(db, collectionConfig.collectionPath);
        const previousFromStorage = checkpointMap?.[collectionName];
        let previousCheckpoint: TCheckpoint | undefined = previousFromStorage;
        const toEvent = (snapshot: QueryDocumentSnapshot<DocumentData>, kind: DocumentChangeType) =>
          toChangeEvent(collectionConfig, snapshot, kind);
        const pullSource = buildPullSource(
          collectionRef,
          collectionConfig.buildPullQueryConstraints?.({ checkpoint: previousFromStorage }) ?? [],
        );
        const firstPull = previousFromStorage === undefined;

        if (firstPull && collectionConfig.countInitialPull) {
          getCountFromServer(pullSource).then(
            (snapshot) => {
              if (!stopped) {
                pullOptions.onCount?.({ collection: collectionName, total: snapshot.data().count });
              }
            },
            // Progress only: the pull goes on without a total.
            () => undefined,
          );
        }

        const listen = () => {
          if (stopped) return;
          let caughtUp = false;
          unsubscribes.push(
            onSnapshot(
              pullSource,
              // Metadata changes tell a server snapshot from a cached one, even when nothing changed.
              { includeMetadataChanges: true },
              (snapshot) => {
                const changes = snapshot
                  .docChanges()
                  // This device's unconfirmed writes: they already carry their new revision.
                  .filter(
                    ({ doc: changed }) =>
                      collectionConfig.revisionField === undefined ||
                      !changed.metadata.hasPendingWrites,
                  )
                  .map((change) => toEvent(change.doc, change.type));
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
                if (!caughtUp && !snapshot.metadata.fromCache) {
                  caughtUp = true;
                  pullOptions.onCaughtUp?.([collectionName]);
                }
              },
              (error: Error) => pullOptions.onError?.(error),
            ),
          );
        };

        const buildPreview = collectionConfig.buildPreviewQueryConstraints;
        if (!firstPull || !buildPreview) {
          listen();
          continue;
        }
        // The listener opens once the preview is queued, so the preview never lands after
        // (and over) newer rows the listener delivered.
        void (async () => {
          try {
            const snapshot = await getDocsFromServer(query(collectionRef, ...buildPreview()));
            if (stopped) return;
            const changes = snapshot.docs.map((document) => toEvent(document, "added"));
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
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    push: async ({ events, commitChanges }) => {
      const collectionByName = new Map(
        collections.map((collectionConfig) => [collectionConfig.collectionName, collectionConfig]),
      );

      // Each event is one write. Writes to one document, in a batch or across batches committed
      // in order, apply in event order, so events need no coalescing. Security rules check every
      // write of a batch against the document before the batch, so one with a revision goes in a
      // batch without another write to its document.
      const newBatch = () => ({
        batch: writeBatch(db),
        events: [] as ChangeBusEvent<C, N>[],
        revisionedDocuments: new Set<string>(),
      });
      const batches: Array<ReturnType<typeof newBatch>> = [];
      let current = newBatch();

      const enqueueSet = (
        event: ChangeBusEvent<C, N>,
        documentPath: string,
        documentId: string,
        payload: DocumentData,
        options?: { merge: boolean },
      ) => {
        const revisioned = collectionByName.get(event.collection as N)!.revisionField !== undefined;
        const documentKey = `${documentPath}/${documentId}`;
        if (
          current.events.length >= FIRESTORE_BATCH_LIMIT ||
          current.revisionedDocuments.has(documentKey)
        ) {
          batches.push(current);
          current = newBatch();
        }
        try {
          // An invalid path or value throws `invalid-argument` here, before any commit.
          const ref = doc(db, documentPath, documentId);
          if (options) {
            current.batch.set(ref, payload, options);
          } else {
            current.batch.set(ref, payload);
          }
        } catch (error) {
          throw firestorePushError(error);
        }
        current.events.push(event);
        if (revisioned) current.revisionedDocuments.add(documentKey);
      };

      /**
       * After rules refused a batch: a `PushConflictError` with the server state of its documents
       * another device wrote first (their revision is not the one this push built on).
       */
      const findPushConflict = async (batchEvents: ChangeBusEvent<C, N>[]) => {
        const serverEvents = await Promise.all(
          batchEvents.map(async (event) => {
            const collectionConfig = collectionByName.get(event.collection as N)!;
            const { collectionPath, revisionField } = collectionConfig;
            if (revisionField === undefined) return undefined;
            const snapshot = await getDocFromServer(
              doc(db, collectionPath, collectionConfig.resolveRemoteId(event)),
            );
            const exists = snapshot.exists();
            const serverRev = exists ? (revisionFrom(snapshot.get(revisionField)) ?? 0) : 0;
            if (serverRev === event.rev! - 1) return undefined;
            return {
              ...toChangeEvent(
                collectionConfig,
                snapshot as QueryDocumentSnapshot<DocumentData>,
                exists ? "modified" : "removed",
              ),
              rev: serverRev,
            };
          }),
        );
        const conflicts = serverEvents.filter((event) => event !== undefined);
        return conflicts.length > 0 ? new PushConflictError(conflicts) : undefined;
      };

      for (const rawEvent of events) {
        const collectionConfig = collectionByName.get(rawEvent.collection as N);
        if (!collectionConfig) continue;
        const event = rawEvent as ChangeBusEvent<C, N>;

        const { collectionPath, revisionField } = collectionConfig;
        const id = collectionConfig.resolveRemoteId(event);
        const withRevision = (payload: DocumentData): DocumentData =>
          revisionField === undefined ? payload : { ...payload, [revisionField]: event.rev };

        if (event.type === "delete") {
          const deletedAt = event.deletedAt ?? Date.now();
          const payload = collectionConfig.serializeDelete
            ? collectionConfig.serializeDelete(event.id as C[N]["delete"], { deletedAt })
            : ({
                deleted: true,
                deletedAt,
              } satisfies DocumentData);
          enqueueSet(event, collectionPath, id, withRevision(payload), { merge: true });
          continue;
        }

        if (event.type === "create") {
          const payload = collectionConfig.serializeCreate
            ? collectionConfig.serializeCreate(event.data as C[N]["create"])
            : (event.data as DocumentData);
          enqueueSet(event, collectionPath, id, withRevision(payload));
          continue;
        }

        const payload = collectionConfig.serializeUpdate
          ? collectionConfig.serializeUpdate(event.data as C[N]["update"])
          : (event.data as DocumentData);
        enqueueSet(event, collectionPath, id, withRevision(payload), { merge: true });
      }
      if (current.events.length > 0) batches.push(current);

      // Batches commit in order, and each is acknowledged before the next commits, so a
      // failed batch leaves only its own and later events in the outbox. A batch is atomic:
      // when one write is refused for good, core narrows the push down to it. A batch refused
      // because another device wrote one of its documents first goes to conflict resolution.
      for (const { batch, events: batchEvents } of batches) {
        try {
          await batch.commit();
        } catch (error) {
          if (isFirestorePermissionDenied(error)) {
            const conflict = await findPushConflict(batchEvents).catch((readError: unknown) => {
              throw firestorePushError(readError);
            });
            if (conflict) throw conflict;
          }
          throw firestorePushError(error);
        }
        await commitChanges({ events: batchEvents });
      }
    },
  };
}
