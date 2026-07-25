import type {
  ChangeBusEvent,
  ChangeBusEventDataMap,
  CollectionConfig,
  InferCollectionCheckpoint,
  InferCollectionInsertModel,
  InferCollectionPrimaryFieldType,
  InferCollectionUpdateModel,
} from "@ez-kits/sync-client-core";
import type { DataSnapshot, Database, Query } from "firebase/database";
import type { CollectionKey } from "../shared/types.ts";

export interface RealtimeDBCollectionSyncHandlers<
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
  buildRealtimePullQuery?: (args: {
    db: Database;
    collectionPath: string;
    checkpoint?: TCheckpoint;
  }) => Query;
  /**
   * Build the next persisted checkpoint after a child event.
   * Defaults to {@link createCheckpoint}.
   */
  createPullCheckpoint?: (args: {
    snapshot: DataSnapshot;
    previousCheckpoint?: TCheckpoint;
  }) => TCheckpoint;
  resolveRecordId?: (event: ChangeBusEvent<C, N>) => string;
  deserializeCreate?: (data: unknown, context: { snapshot: DataSnapshot }) => C[N]["create"];
  deserializeUpdate?: (data: unknown, context: { snapshot: DataSnapshot }) => C[N]["update"];
  deserializeDeleteId?: (context: { snapshot: DataSnapshot }) => C[N]["delete"];
  isDeleted?: (data: unknown, context: { snapshot: DataSnapshot }) => boolean;
  serializeCreate?: (data: C[N]["create"]) => unknown;
  serializeUpdate?: (data: C[N]["update"]) => unknown;
  serializeDelete?: (id: C[N]["delete"]) => unknown;
}

/** Options for per-collection sync (`CollectionConfig.sync`). */
export interface RealtimeDBCollectionSyncOptionsConfig<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
> extends RealtimeDBCollectionSyncHandlers<C, N, TCheckpoint> {
  db: Database;
  /**
   * Local collection name used in change-bus events.
   * Defaults to the last segment of {@link collectionPath}.
   * Must match `CollectionConfig.name`.
   */
  collectionName?: N;
  /** Realtime Database path (e.g. `"todos"` or `"users/uid/todos"`). */
  collectionPath: string;
}

/** Common options shared by all collections on a sync client. */
export interface RealtimeDBSyncCommonOptions {
  db: Database;
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

/** Per-collection options when configuring client-level Realtime DB sync. */
export type RealtimeDBCollectionSyncConfigInput<
  Col extends CollectionConfig<any, any, any, any, any, any, any>,
> = {
  collectionConfig: Col;
  collectionPath: string;
} & RealtimeDBCollectionSyncHandlers<
  CollectionEventMapFromConfig<Col>,
  Col["name"],
  InferCollectionCheckpoint<Col>
>;

/** Resolved per-collection sync config returned by {@link defineRealtimeDBCollectionSyncConfig}. */
export interface RealtimeDBCollectionSyncConfig<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
> extends RealtimeDBCollectionSyncHandlers<C, N, TCheckpoint> {
  collectionName: N;
  collectionPath: string;
}

/** Client-level sync options: common options + per-collection configs. */
export interface RealtimeDBSyncOptionsConfig<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
> extends RealtimeDBSyncCommonOptions {
  collections: readonly RealtimeDBCollectionSyncConfig<C, N, TCheckpoint>[];
}

/** Internal resolved shape used by pull/push. */
export interface ResolvedRealtimeDBCollectionSync<
  C extends ChangeBusEventDataMap,
  N extends CollectionKey<C>,
  TCheckpoint,
> extends RealtimeDBCollectionSyncHandlers<C, N, TCheckpoint> {
  collectionName: N;
  collectionPath: string;
}
