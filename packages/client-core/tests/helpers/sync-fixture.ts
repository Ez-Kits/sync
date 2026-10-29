import { vi } from "vite-plus/test";
import { ChangeBus } from "../../src/change-bus";
import type { ILocalChangeStore, StoredChangeBusEvent } from "../../src/local-change-store";
import { CollectionSyncHandler } from "../../src/sync-handler/collection-sync-handler";
import { GlobalSyncHandler } from "../../src/sync-handler/global-sync-handler";
import { createTestLocalChangeStore } from "./local-change-store";

export type Row = { id: number; title: string };
export type Scope = "global" | "collection";

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
export const settle = async () => {
  for (let i = 0; i < 4; i += 1) await tick();
};

/**
 * A handler over an in-memory table and outbox. The adapter records every pull stream it
 * opens; pushes acknowledge what they send, after `pushGate` when one is set.
 */
export function fixture(scope: Scope, overrides: Record<string, unknown> = {}) {
  const rows = new Map<string, Row>();
  const native = { transaction: "pull" };
  const db = {
    insert: vi.fn(async (_name: string, row: Row) => {
      rows.set(String(row.id), row);
    }),
    update: vi.fn(async (_name: string, row: Row) => {
      rows.set(String(row.id), { ...rows.get(String(row.id))!, ...row });
    }),
    delete: vi.fn(async (_name: string, id: number) => {
      rows.delete(String(id));
    }),
    get: vi.fn(async (_name: string, id: number) => rows.get(String(id))),
    getOptional: vi.fn(async (_name: string, id: number) => rows.get(String(id))),
    getMany: vi.fn(async () => [...rows.values()]),
    transaction: vi.fn(async (fn: (tx: any, context: any) => Promise<unknown>) =>
      fn(db, { operations: db, native }),
    ),
  };
  const checkpoints = new Map<string, unknown>();
  const checkpointStorage = {
    getCheckpoint: vi.fn(async (name: string) => checkpoints.get(name)),
    saveCheckpoint: vi.fn(async (name: string, checkpoint: unknown) => {
      checkpoints.set(name, checkpoint);
    }),
  };
  const store =
    (overrides.localChangeStore as ILocalChangeStore | undefined) ?? createTestLocalChangeStore();
  const streams: Array<{ options: any; cleanup: ReturnType<typeof vi.fn> }> = [];
  const pushed: any[][] = [];
  let pushGate: Promise<void> | undefined;
  const adapter = {
    pull: vi.fn((options: any) => {
      const cleanup = vi.fn();
      streams.push({ options, cleanup });
      return cleanup;
    }),
    push: vi.fn(async ({ events, commitChanges }: any) => {
      pushed.push(events);
      const gate = pushGate;
      if (gate) await gate;
      await commitChanges({ events });
    }),
  };
  const changeBus = new ChangeBus<any>();
  const published: any[][] = [];
  changeBus.subscribe((events: any[]) => published.push(events), { stream: "remote" });
  const onSyncError = vi.fn();
  const onRemoteChangesCommitted = vi.fn();
  const config = {
    collections: [
      {
        name: "todos",
        adapterConfig: {},
        primaryField: "id",
        syncAdapter: scope === "collection" ? adapter : undefined,
      },
    ],
    syncAdapter: scope === "global" ? adapter : undefined,
    db,
    changeBus,
    localChangeStore: store,
    checkpointStorage,
    onSyncError,
    onRemoteChangesCommitted,
    ...overrides,
  };
  const createHandler = () =>
    scope === "global"
      ? new GlobalSyncHandler(config as never)
      : new CollectionSyncHandler(config as never);
  let handler = createHandler();
  return {
    rows,
    native,
    db,
    checkpoints,
    checkpointStorage,
    store,
    streams,
    pushed,
    adapter,
    published,
    onSyncError,
    onRemoteChangesCommitted,
    holdPushes() {
      let release!: () => void;
      pushGate = new Promise<void>((resolve) => (release = resolve));
      return () => {
        pushGate = undefined;
        release();
      };
    },
    start() {
      if (handler instanceof GlobalSyncHandler) handler.start();
      else handler.start("todos" as never);
    },
    stop() {
      if (handler instanceof GlobalSyncHandler) handler.stop();
      else handler.stop("todos" as never);
    },
    /** Push outbox events written by `writeLocally`, as another tab's writes are announced. */
    notifyOutboxChanged() {
      if (handler instanceof GlobalSyncHandler) handler.notifyOutboxChanged();
      else handler.notifyOutboxChanged(["todos"] as never);
    },
    retryRejectedPushes() {
      handler.retryRejectedPushes();
    },
    /** Stop the handler and replace it with a new one over the same rows and store, as a reload does. */
    reload() {
      this.stop();
      handler = createHandler();
    },
    /** A committed local write: the row, its outbox event and its dirty record. */
    async writeLocally(event: StoredChangeBusEvent) {
      if (event.type === "delete") rows.delete(event.recordId);
      else rows.set(event.recordId, event.data as Row);
      await store.appendEvents([event]);
      await store.upsertDirtyRecord({
        collection: "todos",
        recordId: event.recordId,
        state: event.type === "delete" ? "deleted" : "dirty",
        updatedAt: event.createdAt,
      });
    },
  };
}
