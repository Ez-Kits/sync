import { expect, test, vi } from "vite-plus/test";
import { fixture, settle, type Row } from "./helpers/sync-fixture";

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
/** The server-confirmed state of a pushed write, with a server-assigned field. */
const echo = (title: string, updatedAt: number) => ({
  type: "update" as const,
  collection: "todos",
  data: { id: 1, title, updatedAt },
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

  for (const resolver of [undefined, "local"] as const) {
    test(`${scope}: the echo of a push pulled before its acknowledgement is applied by it (${resolver ?? "no resolver"})`, async () => {
      const f = fixture(scope, resolver ? { conflictResolver: () => resolver } : {});
      await f.writeLocally(localEvent("e1", "update", { id: 1, title: "local" }));
      const release = f.holdPushes();
      f.start();
      await vi.waitFor(() => expect(f.streams).toHaveLength(1));
      expect(f.pushed).toHaveLength(1);
      // The provider committed the write; the pull delivers its echo before the acknowledgement.
      f.streams[0]!.options.commitChanges({
        changes: [echo("local", 100)],
        checkpoint: { todos: "c1" },
      });
      await vi.waitFor(() => expect(f.checkpoints.get("todos")).toBe("c1"));
      expect(f.rows.get("1")).toEqual({ id: 1, title: "local" });
      expect(f.onRemoteChangesCommitted).not.toHaveBeenCalled();

      const transactions = f.db.transaction.mock.calls.length;
      release();
      await vi.waitFor(async () => expect(await f.store.getPendingEvents()).toEqual([]));
      // Applied in the acknowledgement's own transaction, which left the record clean.
      expect(f.db.transaction).toHaveBeenCalledTimes(transactions + 1);
      expect(f.rows.get("1")).toEqual({ id: 1, title: "local", updatedAt: 100 });
      expect(await f.store.getDirtyRecords()).toEqual([]);
      expect(f.published.at(-1)).toEqual([echo("local", 100)]);
      expect(f.onRemoteChangesCommitted).toHaveBeenCalledExactlyOnceWith([echo("local", 100)]);
      f.stop();
    });
  }

  test(`${scope}: an older remote write skipped before the acknowledgement yields to the later echo`, async () => {
    const f = fixture(scope);
    await f.writeLocally(localEvent("e1", "update", { id: 1, title: "local" }));
    const release = f.holdPushes();
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    const stream = f.streams[0]!.options;
    stream.commitChanges({ changes: [remoteUpdate("older")], checkpoint: { todos: "c1" } });
    await vi.waitFor(() => expect(f.checkpoints.get("todos")).toBe("c1"));
    expect(f.rows.get("1")?.title).toBe("local");

    release();
    await vi.waitFor(() => expect(f.rows.get("1")?.title).toBe("older"));
    // The push landed after it on the server, so its echo follows and is applied as usual.
    stream.commitChanges({ changes: [echo("local", 100)], checkpoint: { todos: "c2" } });
    await vi.waitFor(() => expect(f.checkpoints.get("todos")).toBe("c2"));
    expect(f.rows.get("1")).toEqual({ id: 1, title: "local", updatedAt: 100 });
    expect(f.onRemoteChangesCommitted.mock.calls).toEqual([
      [[remoteUpdate("older")]],
      [[echo("local", 100)]],
    ]);
    f.stop();
  });

  test(`${scope}: only the latest skipped remote event is applied by the acknowledgement`, async () => {
    const f = fixture(scope);
    await f.writeLocally(localEvent("e1", "update", { id: 1, title: "local" }));
    const release = f.holdPushes();
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    const stream = f.streams[0]!.options;
    stream.commitChanges({ changes: [remoteUpdate("older")], checkpoint: { todos: "c1" } });
    stream.commitChanges({ changes: [echo("local", 100)], checkpoint: { todos: "c2" } });
    await vi.waitFor(() => expect(f.checkpoints.get("todos")).toBe("c2"));
    expect(f.rows.get("1")?.title).toBe("local");

    release();
    await vi.waitFor(() =>
      expect(f.rows.get("1")).toEqual({ id: 1, title: "local", updatedAt: 100 }),
    );
    expect(f.onRemoteChangesCommitted).toHaveBeenCalledExactlyOnceWith([echo("local", 100)]);
    f.stop();
  });

  test(`${scope}: a skipped remote event waits until no write of its record is pending`, async () => {
    const f = fixture(scope);
    await f.writeLocally(localEvent("e1", "update", { id: 1, title: "first" }));
    await f.writeLocally(localEvent("e2", "update", { id: 1, title: "second" }));
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
    let firstAcked = false;
    // Each event is its own provider write, acknowledged once written.
    f.adapter.push.mockImplementation(async ({ events, commitChanges }: any) => {
      for (const event of events) {
        if (event.eventId === "e2") await secondGate;
        await commitChanges({ events: [event] });
        if (event.eventId === "e1") firstAcked = true;
      }
    });
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    await vi.waitFor(() => expect(firstAcked).toBe(true));
    f.streams[0]!.options.commitChanges({ changes: [echo("first", 100)], checkpoint: {} });
    await settle();
    // e2 of the same record is still pending: the remote event stays skipped.
    expect(f.rows.get("1")?.title).toBe("second");
    expect(f.onRemoteChangesCommitted).not.toHaveBeenCalled();

    releaseSecond();
    await vi.waitFor(() =>
      expect(f.rows.get("1")).toEqual({ id: 1, title: "first", updatedAt: 100 }),
    );
    expect(await f.store.getPendingEvents()).toEqual([]);
    f.stop();
  });

  for (const decision of ["remote", "merge"] as const) {
    test(`${scope}: a "${decision}" decision forgets the remote event skipped before it`, async () => {
      const merged = { id: 1, title: "merged" };
      const conflictResolver = vi
        .fn()
        .mockReturnValueOnce("local")
        .mockReturnValueOnce(decision === "remote" ? "remote" : { data: merged });
      const f = fixture(scope, { conflictResolver });
      await f.writeLocally(localEvent("e1", "update", { id: 1, title: "local" }));
      const release = f.holdPushes();
      f.start();
      await vi.waitFor(() => expect(f.streams).toHaveLength(1));
      const stream = f.streams[0]!.options;
      stream.commitChanges({ changes: [remoteUpdate("first")], checkpoint: { todos: "c1" } });
      stream.commitChanges({ changes: [remoteUpdate("second")], checkpoint: { todos: "c2" } });
      await vi.waitFor(() => expect(f.checkpoints.get("todos")).toBe("c2"));
      const expected = decision === "remote" ? { id: 1, title: "second" } : merged;
      expect(f.rows.get("1")).toEqual(expected);

      release();
      await vi.waitFor(async () => expect(await f.store.getPendingEvents()).toEqual([]));
      await settle();
      // Acknowledging the in-flight e1 (and the merged event) must not bring back "first".
      expect(f.rows.get("1")).toEqual(expected);
      expect(f.onRemoteChangesCommitted).toHaveBeenCalledTimes(1);
      f.stop();
    });
  }

  test(`${scope}: a remote event applied normally forgets the one skipped before it`, async () => {
    const f = fixture(scope);
    await f.writeLocally(localEvent("e1", "update", { id: 1, title: "local" }));
    const release = f.holdPushes();
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    const stream = f.streams[0]!.options;
    stream.commitChanges({ changes: [remoteUpdate("first")], checkpoint: { todos: "c1" } });
    await vi.waitFor(() => expect(f.checkpoints.get("todos")).toBe("c1"));
    // The pending write leaves the outbox without an acknowledgement of this handler.
    await f.store.deleteEvents(["e1"]);
    await f.store.removeDirtyRecords([{ collection: "todos", recordId: "1" }]);
    stream.commitChanges({ changes: [remoteUpdate("second")], checkpoint: { todos: "c2" } });
    await vi.waitFor(() => expect(f.rows.get("1")?.title).toBe("second"));

    release();
    await settle();
    expect(f.rows.get("1")?.title).toBe("second");
    expect(f.onRemoteChangesCommitted).toHaveBeenCalledExactlyOnceWith([remoteUpdate("second")]);
    f.stop();
  });

  test(`${scope}: a skipped remote event survives a failed acknowledgement for its retry`, async () => {
    const f = fixture(scope);
    await f.writeLocally(localEvent("e1", "update", { id: 1, title: "local" }));
    const release = f.holdPushes();
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    f.streams[0]!.options.commitChanges({
      changes: [echo("local", 100)],
      checkpoint: { todos: "c1" },
    });
    await vi.waitFor(() => expect(f.checkpoints.get("todos")).toBe("c1"));

    const failure = new Error("acknowledgement failed");
    f.db.transaction.mockRejectedValueOnce(failure);
    release();
    await vi.waitFor(() => expect(f.onSyncError).toHaveBeenCalledWith(failure));
    expect(f.rows.get("1")).toEqual({ id: 1, title: "local" });
    expect(f.onRemoteChangesCommitted).not.toHaveBeenCalled();

    // The push is retried and acknowledged; the remembered echo is applied then.
    await vi.waitFor(() =>
      expect(f.rows.get("1")).toEqual({ id: 1, title: "local", updatedAt: 100 }),
    );
    expect(f.pushed).toHaveLength(2);
    expect(await f.store.getPendingEvents()).toEqual([]);
    expect(f.onRemoteChangesCommitted).toHaveBeenCalledExactlyOnceWith([echo("local", 100)]);
    f.stop();
  });
}
