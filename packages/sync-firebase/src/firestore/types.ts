import type {
  ChangeBusEvent,
  ChangeBusEventDataMap,
  CollectionConfig,
  InferCollectionCheckpoint,
  InferCollectionInsertModel,
  InferCollectionPrimaryFieldType,
  InferCollectionUpdateModel,
} from "@ez-kits/sync-client-core";
import type {
  DocumentData,
  Firestore,
  QueryConstraint,
  QueryDocumentSnapshot,
  QuerySnapshot,
} from "firebase/firestore";
import type { CollectionKey } from "../shared/types.ts";

export interface FirestoreCollectionSyncHandlers<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
> {
  /**
   * Fallback when {@link createPullCheckpoint} is not set (e.g. push-only flows).
   * Prefer {@link createPullCheckpoint} for pull checkpoints that reflect remote state.
   */
  createCheckpoint: () => TCheckpoint;
  /**
   * Optional constraints for incremental pull (e.g. `orderBy` + `startAfter` using values from
   * the pull checkpoint). If omitted or empty, the whole collection is observed.
   */
  buildPullQueryConstraints?: (args: { checkpoint?: TCheckpoint }) => QueryConstraint[];
  /**
   * Build the next persisted checkpoint after applying a snapshot batch.
   * Defaults to {@link createCheckpoint}.
   */
  createPullCheckpoint?: (args: {
    snapshot: QuerySnapshot<DocumentData>;
    previousCheckpoint?: TCheckpoint;
  }) => TCheckpoint;
  /** Forwarded to {@link onSnapshot} (useful with metadata-driven flows). */
  includeMetadataChanges?: boolean;
  resolveDocumentId?: (event: ChangeBusEvent<C, N>) => string;
  deserializeCreate?: (
    data: DocumentData,
    context: { snapshot: QueryDocumentSnapshot<DocumentData> },
  ) => C[N]["create"];
  deserializeUpdate?: (
    data: DocumentData,
    context: { snapshot: QueryDocumentSnapshot<DocumentData> },
  ) => C[N]["update"];
  deserializeDeleteId?: (context: {
    snapshot: QueryDocumentSnapshot<DocumentData>;
  }) => C[N]["delete"];
  isDeleted?: (
    data: DocumentData,
    context: { snapshot: QueryDocumentSnapshot<DocumentData> },
  ) => boolean;
  serializeCreate?: (data: C[N]["create"]) => DocumentData;
  serializeUpdate?: (data: C[N]["update"]) => DocumentData;
  serializeDelete?: (id: C[N]["delete"]) => DocumentData;
}

/** Options for per-collection sync (`CollectionConfig.sync`). */
export interface FirestoreCollectionSyncOptionsConfig<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
> extends FirestoreCollectionSyncHandlers<C, N, TCheckpoint> {
  db: Firestore;
  /**
   * Local collection name used in change-bus events.
   * Defaults to the last segment of {@link collectionPath}.
   * Must match `CollectionConfig.name`.
   */
  collectionName?: N;
  /** Firestore collection path (e.g. `"todos"` or `"users/uid/todos"`). */
  collectionPath: string;
}

/** Common options shared by all collections on a sync client. */
export interface FirestoreSyncCommonOptions {
  db: Firestore;
  includeMetadataChanges?: boolean;
}

type CollectionEventMapFromConfig<Col extends CollectionConfig<any, any, any, any, any, any>> =
  Record<
    Col["name"],
    {
      create: InferCollectionInsertModel<Col>;
      update: InferCollectionUpdateModel<Col>;
      delete: InferCollectionPrimaryFieldType<Col>;
    }
  >;

/** Per-collection options when configuring client-level Firestore sync. */
export type FirestoreCollectionSyncConfigInput<
  Col extends CollectionConfig<any, any, any, any, any, any, any>,
> = {
  collectionConfig: Col;
  collectionPath: string;
} & FirestoreCollectionSyncHandlers<
  CollectionEventMapFromConfig<Col>,
  Col["name"],
  InferCollectionCheckpoint<Col>
>;

/** Resolved per-collection sync config returned by {@link defineFirestoreCollectionSyncConfig}. */
export interface FirestoreCollectionSyncConfig<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
> extends FirestoreCollectionSyncHandlers<C, N, TCheckpoint> {
  collectionName: N;
  collectionPath: string;
}

/** Client-level sync options: common options + per-collection configs. */
export interface FirestoreSyncOptionsConfig<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
> extends FirestoreSyncCommonOptions {
  collections: readonly FirestoreCollectionSyncConfig<C, N, TCheckpoint>[];
}

/** Internal resolved shape used by pull/push. */
export interface ResolvedFirestoreCollectionSync<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
> extends FirestoreCollectionSyncHandlers<C, N, TCheckpoint> {
  collectionName: N;
  collectionPath: string;
}
