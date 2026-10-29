import { expect, test, vi } from "vite-plus/test";
import { ChangeBus } from "../src/change-bus";
import type { StoredChangeBusEvent } from "../src/local-change-store";
import { CollectionSyncHandler } from "../src/sync-handler/collection-sync-handler";
import { GlobalSyncHandler } from "../src/sync-handler/global-sync-handler";
import { createTestLocalChangeStore } from "./helpers/local-change-store";

type Row = { id: number; title: string };
type Scope = "global" | "collection";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 4; i += 1) await tick();
};

/**
 * A handler over an in-memory table and outbox. The adapter records every pull stream it
 * opens; pushes acknowledge what they send, after `pushGate` when one is set.
 */
function fixture(scope: Scope, overrides: Record<string, unknown> = {}) {
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
  const store = createTestLocalChangeStore();
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
  const handler =
    scope === "global"
      ? new GlobalSyncHandler(config as never)
      : new CollectionSyncHandler(config as never);
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

const localEvent = (id: string, type: "create" | "update" | "delete", data?: Row) => ({
  id,
  type,
  collection: "todos",
  recordId: "1",
  data: data ?? null,
  createdAt: 1,
});
const remoteUpdate = (title: string) => ({
  type: "update" as const,
  collection: "todos",
  data: { id: 1, title },
});

for (const scope of ["global", "collection"] as const) {
  test(`${scope}: a failed pull commit re-subscribes from the persisted checkpoint`, async () => {
    const f = fixture(scope);
    f.checkpoints.set("todos", "c0");
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    const stale = f.streams[0]!;
    expect(stale.options.checkpoint).toEqual({ todos: "c0" });

    const failure = new Error("transaction closed");
    f.db.transaction.mockRejectedValueOnce(failure);
    stale.options.commitChanges({
      changes: [{ type: "create", collection: "todos", data: { id: 1, title: "one" } }],
      checkpoint: { todos: "c1" },
    });
    await vi.waitFor(() => expect(f.onSyncError).toHaveBeenCalledWith(failure));
    expect(stale.cleanup).toHaveBeenCalledOnce();

    // The provider only sends what came after the failed batch; it must not move the checkpoint.
    stale.options.commitChanges({
      changes: [{ type: "create", collection: "todos", data: { id: 2, title: "two" } }],
      checkpoint: { todos: "c2" },
    });
    await settle();
    expect(f.rows.has("2")).toBe(false);
    expect(f.checkpointStorage.saveCheckpoint).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(f.streams).toHaveLength(2));
    const fresh = f.streams[1]!;
    expect(fresh.options.checkpoint).toEqual({ todos: "c0" });
    fresh.options.commitChanges({
      changes: [
        { type: "create", collection: "todos", data: { id: 1, title: "one" } },
        { type: "create", collection: "todos", data: { id: 2, title: "two" } },
      ],
      checkpoint: { todos: "c2" },
    });
    await vi.waitFor(() => expect(f.checkpoints.get("todos")).toBe("c2"));
    expect([...f.rows.keys()]).toEqual(["1", "2"]);
    f.stop();
    expect(fresh.cleanup).toHaveBeenCalledOnce();
  });

  test(`${scope}: batches queued behind a failed pull commit are dropped`, async () => {
    const f = fixture(scope);
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    const stale = f.streams[0]!;
    let fail!: (error: unknown) => void;
    f.db.transaction.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (fail = reject)),
    );
    stale.options.commitChanges({
      changes: [{ type: "create", collection: "todos", data: { id: 1, title: "one" } }],
      checkpoint: { todos: "c1" },
    });
    stale.options.commitChanges({
      changes: [{ type: "create", collection: "todos", data: { id: 2, title: "two" } }],
      checkpoint: { todos: "c2" },
    });
    await vi.waitFor(() => expect(fail).toBeDefined());
    fail(new Error("leader changed"));
    await settle();
    expect(f.rows.size).toBe(0);
    expect(f.checkpointStorage.saveCheckpoint).not.toHaveBeenCalled();
    expect(f.onRemoteChangesCommitted).not.toHaveBeenCalled();
    expect(stale.cleanup).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(f.streams).toHaveLength(2));
    expect(f.streams[1]!.options.checkpoint ?? {}).toEqual({});
    f.stop();
  });

  test(`${scope}: a "remote" resolution drops the record's pending writes`, async () => {
    const f = fixture(scope, { conflictResolver: () => "remote" });
    await f.writeLocally(localEvent("e1", "update", { id: 1, title: "local" }));
    const release = f.holdPushes();
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    // A push already in flight read e1 before the pull rewrote the outbox.
    expect(f.pushed).toHaveLength(1);
    f.streams[0]!.options.commitChanges({ changes: [remoteUpdate("remote")], checkpoint: {} });
    await vi.waitFor(() => expect(f.rows.get("1")?.title).toBe("remote"));
    expect(await f.store.getPendingEvents()).toEqual([]);
    expect(await f.store.getDirtyRecords()).toEqual([]);
    const deleteEvents = vi.spyOn(f.store, "deleteEvents");
    release();
    await settle();
    // Its acknowledgement of a removed event leaves the outbox empty and clean.
    expect(deleteEvents).toHaveBeenCalledWith(["e1"], f.native);
    expect(await f.store.getPendingEvents()).toEqual([]);
    expect(await f.store.getDirtyRecords()).toEqual([]);
    expect(f.pushed).toHaveLength(1);
    expect(f.onSyncError).not.toHaveBeenCalled();
    f.stop();
  });

  test(`${scope}: a merge replaces the pending writes with one pushed merged event`, async () => {
    const merged = { id: 1, title: "merged" };
    const f = fixture(scope, { conflictResolver: () => ({ data: merged }) });
    await f.writeLocally(localEvent("e1", "create", { id: 1, title: "local" }));
    await f.writeLocally(localEvent("e2", "update", { id: 1, title: "local again" }));
    const release = f.holdPushes();
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    // The initial push holds e1 and e2 while the pull rewrites the outbox.
    expect(f.pushed[0]!.map((event) => event.eventId)).toEqual(["e1", "e2"]);
    const appendEvents = vi.spyOn(f.store, "appendEvents");
    f.streams[0]!.options.commitChanges({ changes: [remoteUpdate("remote")], checkpoint: {} });
    await vi.waitFor(() => expect(f.rows.get("1")).toEqual(merged));
    const pending = await f.store.getPendingEvents();
    expect(pending).toEqual([
      expect.objectContaining({ type: "update", collection: "todos", recordId: "1", data: merged }),
    ]);
    const mergedId = pending[0]!.id;
    expect(["e1", "e2"]).not.toContain(mergedId);
    expect(appendEvents).toHaveBeenCalledWith(pending, f.native);
    expect(await f.store.getDirtyRecords()).toEqual([
      expect.objectContaining({ recordId: "1", state: "dirty" }),
    ]);
    expect(f.published.at(-1)).toEqual([{ ...remoteUpdate("remote"), data: merged }]);
    expect(f.onRemoteChangesCommitted).toHaveBeenCalledWith([
      { ...remoteUpdate("remote"), data: merged },
    ]);

    // Acknowledging the in-flight e1/e2 keeps the merged event and its dirty record.
    let outboxBeforeSecondPush: unknown;
    f.adapter.push.mockImplementationOnce(async ({ events, commitChanges }: any) => {
      outboxBeforeSecondPush = {
        pending: await f.store.getPendingEvents(),
        dirty: await f.store.getDirtyRecords(),
      };
      f.pushed.push(events);
      await commitChanges({ events });
    });
    release();
    await vi.waitFor(() => expect(f.pushed).toHaveLength(2));
    expect(outboxBeforeSecondPush).toEqual({
      pending,
      dirty: [expect.objectContaining({ recordId: "1", state: "dirty" })],
    });
    expect(f.pushed[1]).toEqual([
      { type: "update", collection: "todos", data: merged, eventId: mergedId },
    ]);
    await vi.waitFor(async () => expect(await f.store.getPendingEvents()).toEqual([]));
    expect(await f.store.getDirtyRecords()).toEqual([]);
    f.stop();
  });

  test(`${scope}: a merge of a remote delete recreates the record`, async () => {
    const merged = { id: 1, title: "kept" };
    const f = fixture(scope, { conflictResolver: () => ({ data: merged }) });
    await f.writeLocally(localEvent("e1", "update", { id: 1, title: "local" }));
    f.adapter.push.mockImplementation(async ({ events }: any) => {
      f.pushed.push(events);
      throw new Error("offline");
    });
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    f.streams[0]!.options.commitChanges({
      changes: [{ type: "delete", collection: "todos", id: 1, deletedAt: 5 }],
      checkpoint: {},
    });
    await vi.waitFor(async () =>
      expect(await f.store.getPendingEvents()).toEqual([
        expect.objectContaining({ type: "create", recordId: "1", data: merged }),
      ]),
    );
    expect(f.rows.get("1")).toEqual(merged);
    expect(f.published.at(-1)).toEqual([{ type: "create", collection: "todos", data: merged }]);
    expect(await f.store.getDirtyRecords()).toEqual([
      expect.objectContaining({ recordId: "1", state: "dirty" }),
    ]);
    f.stop();
  });

  test(`${scope}: a "local" resolution keeps the row and the outbox`, async () => {
    const f = fixture(scope, { conflictResolver: () => "local" });
    await f.writeLocally(localEvent("e1", "update", { id: 1, title: "local" }));
    f.holdPushes();
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    f.streams[0]!.options.commitChanges({
      changes: [remoteUpdate("remote"), { type: "create", collection: "todos", data: { id: 2 } }],
      checkpoint: { todos: "c1" },
    });
    await vi.waitFor(() => expect(f.checkpoints.get("todos")).toBe("c1"));
    expect(f.rows.get("1")?.title).toBe("local");
    expect((await f.store.getPendingEvents()).map((event) => event.id)).toEqual(["e1"]);
    // Only what was applied is announced.
    expect(f.published.at(-1)).toEqual([{ type: "create", collection: "todos", data: { id: 2 } }]);
    expect(f.onRemoteChangesCommitted).toHaveBeenCalledWith([
      { type: "create", collection: "todos", data: { id: 2 } },
    ]);
    f.stop();
  });

  test(`${scope}: without a resolver pending local writes keep the local state`, async () => {
    const f = fixture(scope);
    await f.writeLocally(localEvent("e1", "delete"));
    f.holdPushes();
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    f.streams[0]!.options.commitChanges({ changes: [remoteUpdate("remote")], checkpoint: {} });
    await settle();
    // The local delete is not resurrected, and is still pushed.
    expect(f.rows.has("1")).toBe(false);
    expect((await f.store.getPendingEvents()).map((event) => event.id)).toEqual(["e1"]);
    expect(f.published.at(-1)).toEqual([]);
    expect(f.onRemoteChangesCommitted).not.toHaveBeenCalled();
    f.stop();
  });
}
