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
import type { DataSnapshot, Database, Query } from "firebase/database";
import type { CollectionKey } from "../shared/types.ts";

export interface RealtimeDBSyncAdapterCollectionHandlers<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
> {
  /**
   * Fallback when {@link createPullCheckpoint} is not set.
   * Prefer {@link createPullCheckpoint} for pull checkpoints that reflect remote state.
   */
  createCheckpoint: () => TCheckpoint;
  /**
   * Narrow the pull listener (e.g. `query(ref, orderByChild('updatedAt'), startAt(ts))`)
   * for incremental sync. Defaults to the collection root `ref`.
   */
  buildPullQuery?: (args: {
    db: Database;
    collectionPath: string;
    checkpoint?: TCheckpoint;
  }) => Query;
  /**
   * A small query read first, on the collection's first pull on this device (no checkpoint
   * yet), so the app can show rows before the full pull arrives: e.g.
   * `query(ref(db, collectionPath), orderByChild("updatedAt"), limitToLast(50))`. Its rows
   * commit without a checkpoint, and the child listeners open after it; it also answers
   * `hasRemoteData`. Offline or refused, it is skipped.
   */
  buildPreviewQuery?: (args: { db: Database; collectionPath: string }) => Query;
  /**
   * On the collection's first pull on this device, how many children the full pull
   * delivers, for `progress.total`. Realtime Database has no server-side count, so supply it:
   * e.g. read a counter node your writes (or a Cloud Function) keep up to date. A failure or a
   * non-finite number leaves the total unknown.
   */
  countInitialPull?: (args: { db: Database; collectionPath: string }) => number | Promise<number>;
  /**
   * Build the next persisted checkpoint after a child event.
   * Defaults to {@link createCheckpoint}.
   */
  createPullCheckpoint?: (args: {
    snapshot: DataSnapshot;
    previousCheckpoint?: TCheckpoint;
  }) => TCheckpoint;
  resolveRemoteId: (event: ChangeBusEvent<C, N>) => string;
  deserializeCreate?: (data: unknown, context: { snapshot: DataSnapshot }) => C[N]["create"];
  deserializeUpdate?: (data: unknown, context: { snapshot: DataSnapshot }) => C[N]["update"];
  deserializeDeleteId?: (context: { snapshot: DataSnapshot }) => C[N]["delete"];
  isDeleted?: (data: unknown, context: { snapshot: DataSnapshot }) => boolean;
  resolveDeletedAt?: (data: unknown, context: { snapshot: DataSnapshot }) => number | undefined;
  serializeCreate?: (data: C[N]["create"]) => unknown;
  serializeUpdate?: (data: C[N]["update"]) => unknown;
  serializeDelete?: (id: C[N]["delete"], context: { deletedAt: number }) => unknown;
}

/** Realtime Database adapter configuration for one collection. */
export interface RealtimeDBCollectionSyncAdapterConfig<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
> extends RealtimeDBSyncAdapterCollectionHandlers<C, N, TCheckpoint> {
  db: Database;
  /**
   * How the adapter's checkpoints are stored in the database. Default: the sync client's
   * `JSON.stringify` / `JSON.parse`.
   */
  checkpointSerializer?: CheckpointSerializer<TCheckpoint>;
  /**
   * Local collection name used in change-bus events.
   * Defaults to the last segment of {@link collectionPath}.
   * Must match `CollectionConfig.name`.
   */
  collectionName?: N;
  /** Realtime Database path (e.g. `"todos"` or `"users/uid/todos"`). */
  collectionPath: string;
}

/** Common Realtime Database adapter configuration. */
export interface RealtimeDBSyncCommonAdapterConfig {
  db: Database;
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
 * Collection mapping input used by the client-level RTDB adapter. The checkpoint type is
 * inferred from the handlers (`createCheckpoint`, `createPullCheckpoint`).
 */
export type RealtimeDBCollectionSyncAdapterConfigInput<
  Col extends CollectionConfig<any, any, any, any, any, any, any>,
  TCheckpoint = unknown,
> = {
  collectionConfig: Col;
  collectionPath: string;
} & RealtimeDBSyncAdapterCollectionHandlers<
  CollectionEventMapFromConfig<Col>,
  Col["name"],
  TCheckpoint
>;

/** Resolved per-collection sync config returned by {@link defineRealtimeDBCollectionSyncAdapterConfig}. */
export interface RealtimeDBSyncAdapterCollectionConfig<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
> extends RealtimeDBSyncAdapterCollectionHandlers<C, N, TCheckpoint> {
  collectionName: N;
  collectionPath: string;
}

/** Client-level Realtime Database adapter configuration. */
export interface RealtimeDBSyncAdapterConfig<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
> extends RealtimeDBSyncCommonAdapterConfig {
  collections: readonly RealtimeDBSyncAdapterCollectionConfig<C, N, TCheckpoint>[];
  /**
   * How the adapter's checkpoints are stored in the database. Default: the sync client's
   * `JSON.stringify` / `JSON.parse`.
   */
  checkpointSerializer?: CheckpointSerializer<TCheckpoint>;
}

/** Internal resolved shape used by pull/push. */
export interface ResolvedRealtimeDBSyncAdapterCollectionConfig<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
> extends RealtimeDBSyncAdapterCollectionHandlers<C, N, TCheckpoint> {
  collectionName: N;
  collectionPath: string;
}
