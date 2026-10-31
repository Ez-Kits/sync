import type {
  ChangeBusEvent,
  ChangeBusEventDataMap,
  CheckpointSerializer,
  CollectionConfig,
  InferCollectionInsertModel,
  InferCollectionPrimaryFieldType,
  InferCollectionSelectModel,
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

export interface FirestoreSyncAdapterCollectionHandlers<
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
  resolveRemoteId: (event: ChangeBusEvent<C, N>) => string;
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
  resolveDeletedAt?: (
    data: DocumentData,
    context: { snapshot: QueryDocumentSnapshot<DocumentData> },
  ) => number | undefined;
  serializeCreate?: (data: C[N]["create"]) => DocumentData;
  serializeUpdate?: (data: C[N]["update"]) => DocumentData;
  serializeDelete?: (id: C[N]["delete"], context: { deletedAt: number }) => DocumentData;
}

/** Firestore adapter configuration for one collection. */
export interface FirestoreCollectionSyncAdapterConfig<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
> extends FirestoreSyncAdapterCollectionHandlers<C, N, TCheckpoint> {
  db: Firestore;
  /**
   * How the adapter's checkpoints are stored in the database. Default: the sync client's
   * `JSON.stringify` / `JSON.parse`, which turns a `Timestamp` into a plain object: set one
   * that rebuilds it when the checkpoint holds `Timestamp`s.
   */
  checkpointSerializer?: CheckpointSerializer<TCheckpoint>;
  /**
   * Local collection name used in change-bus events.
   * Defaults to the last segment of {@link collectionPath}.
   * Must match `CollectionConfig.name`.
   */
  collectionName?: N;
  /** Firestore collection path (e.g. `"todos"` or `"users/uid/todos"`). */
  collectionPath: string;
}

/** Common Firestore adapter configuration shared by all collections. */
export interface FirestoreSyncCommonAdapterConfig {
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
      record: InferCollectionSelectModel<Col>;
    }
  >;

/**
 * Collection mapping input used by the client-level Firestore adapter. The checkpoint type is
 * inferred from the handlers (`createCheckpoint`, `createPullCheckpoint`).
 */
export type FirestoreCollectionSyncAdapterConfigInput<
  Col extends CollectionConfig<any, any, any, any, any, any, any>,
  TCheckpoint = unknown,
> = {
  collectionConfig: Col;
  collectionPath: string;
} & FirestoreSyncAdapterCollectionHandlers<
  CollectionEventMapFromConfig<Col>,
  Col["name"],
  TCheckpoint
>;

/** Resolved per-collection sync config returned by {@link defineFirestoreCollectionSyncAdapterConfig}. */
export interface FirestoreSyncAdapterCollectionConfig<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
> extends FirestoreSyncAdapterCollectionHandlers<C, N, TCheckpoint> {
  collectionName: N;
  collectionPath: string;
}

/** Client-level Firestore adapter configuration. */
export interface FirestoreSyncAdapterConfig<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
> extends FirestoreSyncCommonAdapterConfig {
  collections: readonly FirestoreSyncAdapterCollectionConfig<C, N, TCheckpoint>[];
  /**
   * How the adapter's checkpoints are stored in the database. Default: the sync client's
   * `JSON.stringify` / `JSON.parse`, which turns a `Timestamp` into a plain object: set one
   * that rebuilds it when the checkpoint holds `Timestamp`s.
   */
  checkpointSerializer?: CheckpointSerializer<TCheckpoint>;
}

/** Internal resolved shape used by pull/push. */
export interface ResolvedFirestoreSyncAdapterCollectionConfig<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
> extends FirestoreSyncAdapterCollectionHandlers<C, N, TCheckpoint> {
  collectionName: N;
  collectionPath: string;
}
