import { afterEach, expect, test, vi } from "vite-plus/test";
import { PushConflictError, PushRejectedError } from "../src/sync-handler";
import { fixture, settle, type Scope } from "./helpers/sync-fixture";

afterEach(() => {
  vi.useRealTimers();
});

type EventType = "create" | "update" | "delete";

const local = (id: string, type: EventType, data: object = {}, recordId = "1") => ({
  id,
  type,
  collection: "todos",
  recordId,
  data: type === "delete" ? { id: Number(recordId) } : { id: Number(recordId), ...data },
  createdAt: 1,
});
const remote = (rev: number, data: object = { title: "remote" }, id = 1) => ({
  type: "update" as const,
  collection: "todos",
  data: { id, ...data },
  rev,
});
const remoteDelete = (rev: number) => ({
  type: "delete" as const,
  collection: "todos",
  id: 1,
  rev,
});
const key = { collection: "todos", recordId: "1" };

/** A fixture whose adapter keeps revisions on `todos`, with a stream open. */
async function started(scope: Scope, overrides: Record<string, unknown> = {}) {
  const f = fixture(scope, overrides);
  Object.assign(f.adapter, { revisionedCollections: ["todos"] });
  const hold = f.holdPushes();
  f.start();
  await vi.waitFor(() => expect(f.streams).toHaveLength(1));
  await settle();
  return { f, hold, stream: f.streams[0]!.options };
}

/** Deliver one pulled batch and wait for its checkpoint. */
async function pull(f: ReturnType<typeof fixture>, stream: any, changes: unknown[]) {
  const checkpoint = `c${stream.pulls ?? 0}`;
  stream.pulls = (stream.pulls ?? 0) + 1;
  stream.commitChanges({ changes, checkpoint: { todos: checkpoint } });
  await vi.waitFor(() => expect(f.checkpoints.get("todos")).toBe(checkpoint));
}

const revs = (events: any[]) => events.map(({ rev }) => rev);

test("PushConflictError carries the server events and is not a permanent refusal", () => {
  const cause = new Error("denied");
  const error = new PushConflictError([remote(2)], "conflict", { cause });
  expect(error).toMatchObject({ name: "PushConflictError", events: [remote(2)], cause });
  expect((error as { permanent?: boolean }).permanent).toBeUndefined();
  expect(new PushConflictError([]).message).toBe("Another device wrote these records first.");
});

for (const scope of ["global", "collection"] as const) {
  test(`${scope}: pushed events are numbered per record, and acknowledged revisions stored`, async () => {
    const f = fixture(scope);
    Object.assign(f.adapter, { revisionedCollections: ["todos"] });
    await f.store.upsertRevision({ ...key, rev: 4 });
    await f.writeLocally(local("e1", "update", { title: "a" }));
    await f.writeLocally(local("e2", "update", { title: "b" }));
    await f.writeLocally(local("e3", "create", { title: "c" }, "2"));
    f.start();
    await vi.waitFor(() => expect(f.pushed).toHaveLength(1));
    expect(f.pushed[0]!.map(({ eventId, rev }) => [eventId, rev])).toEqual([
      ["e1", 5],
      ["e2", 6],
      ["e3", 1],
    ]);
    await vi.waitFor(async () => expect(await f.store.getPendingEvents()).toEqual([]));
    expect(await f.store.getRevision(key)).toBe(6);
    expect(await f.store.getRevision({ ...key, recordId: "2" })).toBe(1);
    f.stop();
  });

  test(`${scope}: a collection the adapter does not list gets no revisions`, async () => {
    const f = fixture(scope);
    Object.assign(f.adapter, { revisionedCollections: ["other"] });
    await f.writeLocally(local("e1", "update", { title: "a" }));
    f.start();
    await vi.waitFor(() => expect(f.pushed).toHaveLength(1));
    expect(f.pushed[0]![0]).not.toHaveProperty("rev");
    await vi.waitFor(async () => expect(await f.store.getPendingEvents()).toEqual([]));
    expect(await f.store.getRevision(key)).toBeUndefined();
    f.stop();
  });

  test(`${scope}: a pulled revision at or below the stored one is dropped, its checkpoint saved`, async () => {
    const { f, stream, hold } = await started(scope);
    hold();
    await f.store.upsertRevision({ ...key, rev: 3 });
    await pull(f, stream, [remote(3), remote(2)]);
    expect(f.rows.size).toBe(0);
    expect(f.onRemoteChangesCommitted).not.toHaveBeenCalled();
    expect(await f.store.getRevision(key)).toBe(3);
    f.stop();
  });

  test(`${scope}: without pending writes a pulled event is applied and its revision stored`, async () => {
    const { f, stream, hold } = await started(scope);
    hold();
    await f.store.upsertSkippedRemoteEvent({ ...key, event: remote(1) });
    await pull(f, stream, [remote(2, { title: "applied" })]);
    expect(f.rows.get("1")).toEqual({ id: 1, title: "applied" });
    expect(await f.store.getRevision(key)).toBe(2);
    expect(await f.store.getSkippedRemoteEvents()).toEqual([]);
    f.stop();
  });

  test(`${scope}: an echo pulled before the acknowledgement is dropped by it, without a revert`, async () => {
    const resolveConflict = vi.fn(() => "remote" as const);
    const { f, stream, hold } = await started(scope, { resolveConflict });
    await f.writeLocally(local("e1", "update", { title: "one" }));
    await f.writeLocally(local("e2", "update", { title: "two" }));
    f.notifyOutboxChanged();
    await vi.waitFor(() => expect(f.pushed).toHaveLength(1));
    expect(revs(f.pushed[0]!)).toEqual([1, 2]);

    await pull(f, stream, [remote(2, { title: "one" })]);
    expect(resolveConflict).not.toHaveBeenCalled();
    expect(f.rows.get("1")).toMatchObject({ title: "two" });
    expect(await f.store.getSkippedRemoteEvents()).toHaveLength(1);

    hold();
    await vi.waitFor(async () => expect(await f.store.getPendingEvents()).toEqual([]));
    expect(f.rows.get("1")).toMatchObject({ title: "two" });
    expect(await f.store.getRevision(key)).toBe(2);
    expect(await f.store.getSkippedRemoteEvents()).toEqual([]);
    expect(f.onRemoteChangesCommitted).not.toHaveBeenCalled();
    f.stop();
  });

  test(`${scope}: an echo after a local delete leaves the row deleted`, async () => {
    const { f, stream, hold } = await started(scope);
    await f.store.upsertRevision({ ...key, rev: 1 });
    await f.writeLocally(local("e2", "delete"));
    f.notifyOutboxChanged();
    await vi.waitFor(() => expect(f.pushed).toHaveLength(1));
    await pull(f, stream, [remote(2, { title: "stale" })]);
    hold();
    await vi.waitFor(async () => expect(await f.store.getPendingEvents()).toEqual([]));
    expect(f.rows.has("1")).toBe(false);
    await pull(f, stream, [remote(2, { title: "stale" })]);
    expect(f.rows.has("1")).toBe(false);
    f.stop();
  });

  test(`${scope}: discarding a refused write applies the skipped event above the stored revision`, async () => {
    const onPushRejected = vi.fn();
    const { f, stream, hold } = await started(scope, { onPushRejected });
    hold();
    f.adapter.push.mockImplementation(async () => {
      throw new PushRejectedError("refused");
    });
    await f.writeLocally(local("e1", "update", { title: "refused" }));
    f.notifyOutboxChanged();
    await vi.waitFor(() => expect(onPushRejected).toHaveBeenCalledOnce());
    // Parked without a number: it was never written.
    expect(onPushRejected.mock.calls[0]![0].event).not.toHaveProperty("rev");

    await pull(f, stream, [remote(1, { title: "other device" })]);
    await onPushRejected.mock.calls[0]![0].discard();
    expect(f.rows.get("1")).toEqual({ id: 1, title: "other device" });
    expect(await f.store.getRevision(key)).toBe(1);
    expect(await f.store.getSkippedRemoteEvents()).toEqual([]);
    expect(f.onRemoteChangesCommitted).toHaveBeenCalledExactlyOnceWith([
      remote(1, { title: "other device" }),
    ]);
    f.stop();
  });

  test(`${scope}: an acknowledgement never lowers a revision a conflict stored meanwhile`, async () => {
    const resolveConflict = vi.fn(() => "remote" as const);
    const { f, stream, hold } = await started(scope, { resolveConflict });
    await f.writeLocally(local("e1", "update", { title: "mine" }));
    f.notifyOutboxChanged();
    await vi.waitFor(() => expect(f.pushed).toHaveLength(1));
    await pull(f, stream, [remote(4, { title: "other" })]);
    expect(await f.store.getRevision(key)).toBe(4);
    hold();
    await settle();
    expect(await f.store.getRevision(key)).toBe(4);
    expect(f.rows.get("1")).toEqual({ id: 1, title: "other" });
    f.stop();
  });

  test(`${scope}: another device's write reaches the resolver; "remote" drops the pending writes`, async () => {
    const resolveConflict = vi.fn(() => "remote" as const);
    const { f, stream } = await started(scope, { resolveConflict });
    await f.writeLocally(local("e1", "update", { title: "mine" }));
    await pull(f, stream, [remote(2, { title: "theirs" })]);
    expect(resolveConflict).toHaveBeenCalledExactlyOnceWith({
      remote: remote(2, { title: "theirs" }),
      local: { id: 1, title: "mine" },
    });
    expect(f.rows.get("1")).toEqual({ id: 1, title: "theirs" });
    expect(await f.store.getPendingEvents()).toEqual([]);
    expect(await f.store.getRevision(key)).toBe(2);
    f.stop();
  });

  test(`${scope}: { data } replaces the pending writes and is pushed after the conflicting revision`, async () => {
    const resolveConflict = vi.fn(() => ({ data: { id: 1, title: "merged" } }));
    const { f, stream, hold } = await started(scope, { resolveConflict });
    await f.writeLocally(local("e1", "update", { title: "mine" }));
    await pull(f, stream, [remote(5, { title: "theirs" })]);
    expect(f.rows.get("1")).toEqual({ id: 1, title: "merged" });
    expect(await f.store.getRevision(key)).toBe(5);
    hold();
    await vi.waitFor(() => expect(f.pushed.flat().at(-1)).toMatchObject({ rev: 6 }));
    await vi.waitFor(async () => expect(await f.store.getRevision(key)).toBe(6));
    f.stop();
  });

  test(`${scope}: "local" applies the remote row and replays the pending writes over it`, async () => {
    const resolveConflict = vi.fn(() => "local" as const);
    const { f, stream } = await started(scope, { resolveConflict });
    await f.store.upsertSkippedRemoteEvent({ ...key, event: remote(1) });
    await f.writeLocally(local("e1", "update", { title: "mine" }));
    await pull(f, stream, [remote(3, { title: "theirs", note: "kept" })]);
    expect(f.rows.get("1")).toEqual({ id: 1, title: "mine", note: "kept" });
    expect(await f.store.getRevision(key)).toBe(3);
    expect((await f.store.getPendingEvents()).map(({ id }) => id)).toEqual(["e1"]);
    expect(await f.store.getSkippedRemoteEvents()).toEqual([]);
    f.stop();
  });

  test(`${scope}: without a resolver a conflict is replayed like "local"`, async () => {
    const { f, stream } = await started(scope);
    await f.writeLocally(local("e1", "update", { title: "mine" }));
    await pull(f, stream, [remote(3, { title: "theirs", note: "kept" })]);
    expect(f.rows.get("1")).toEqual({ id: 1, title: "mine", note: "kept" });
    expect(await f.store.getRevision(key)).toBe(3);
    f.stop();
  });

  for (const [name, writes, remoteEvent, expected] of [
    [
      "a create replaces the row",
      [local("e1", "create", { title: "created" })],
      remote(3, { title: "theirs", note: "dropped" }),
      { id: 1, title: "created" },
    ],
    [
      "a delete removes the row",
      [local("e1", "update", { title: "mine" }), local("e2", "delete")],
      remote(3),
      undefined,
    ],
    [
      "an update over a remote delete stays deleted",
      [local("e1", "update", { title: "mine" })],
      remoteDelete(3),
      undefined,
    ],
    [
      "a create after a remote delete brings the row back",
      [local("e1", "create", { title: "again" })],
      remoteDelete(3),
      { id: 1, title: "again" },
    ],
    [
      "a delete over a remote delete stays deleted",
      [local("e1", "delete")],
      remoteDelete(3),
      undefined,
    ],
  ] as const) {
    test(`${scope}: "local" replay: ${name}`, async () => {
      const { f, stream } = await started(scope, { resolveConflict: () => "local" });
      for (const write of writes) await f.writeLocally(write);
      await pull(f, stream, [remoteEvent]);
      expect(f.rows.get("1")).toEqual(expected);
      expect(await f.store.getPendingEvents()).toHaveLength(writes.length);
      f.stop();
    });
  }

  test(`${scope}: a pulled event without a revision is handled as today`, async () => {
    const { f, stream, hold } = await started(scope);
    await f.store.upsertRevision({ ...key, rev: 7 });
    await f.writeLocally(local("e1", "update", { title: "mine" }));
    f.notifyOutboxChanged();
    await vi.waitFor(() => expect(f.pushed).toHaveLength(1));
    const removed = { type: "delete" as const, collection: "todos", id: 1 };
    await pull(f, stream, [removed]);
    expect(f.rows.has("1")).toBe(true);
    expect(await f.store.getSkippedRemoteEvents()).toEqual([{ ...key, event: removed }]);
    expect(await f.store.getRevision(key)).toBe(7);
    hold();
    await vi.waitFor(() => expect(f.rows.has("1")).toBe(false));
    f.stop();
  });

  test(`${scope}: a push conflict goes to the resolver and the outbox is pushed again`, async () => {
    const onPushRejected = vi.fn();
    const resolveConflict = vi.fn(() => "local" as const);
    const { f, hold, stream } = await started(scope, { onPushRejected, resolveConflict });
    hold();
    const server = remote(1, { title: "theirs", note: "kept" });
    f.adapter.push.mockImplementationOnce(async () => {
      throw new PushConflictError([server]);
    });
    await f.writeLocally(local("e1", "update", { title: "mine" }));
    f.notifyOutboxChanged();
    await vi.waitFor(() => expect(f.pushed).toHaveLength(1));

    expect(resolveConflict).toHaveBeenCalledExactlyOnceWith({
      remote: server,
      local: { id: 1, title: "mine" },
    });
    expect(f.pushed[0]).toMatchObject([{ eventId: "e1", rev: 2 }]);
    await vi.waitFor(async () => expect(await f.store.getRevision(key)).toBe(2));
    expect(f.rows.get("1")).toEqual({ id: 1, title: "mine", note: "kept" });
    expect(onPushRejected).not.toHaveBeenCalled();
    expect(f.onSyncError).not.toHaveBeenCalled();
    expect(f.onRemoteChangesCommitted).toHaveBeenCalledOnce();
    // The server state, pulled later, is settled already.
    await pull(f, stream, [server]);
    expect(resolveConflict).toHaveBeenCalledOnce();
    f.stop();
  });

  test(`${scope}: a push conflict is another device's write even within the pending revisions`, async () => {
    const resolveConflict = vi.fn(() => "remote" as const);
    const { f, hold } = await started(scope, { resolveConflict });
    hold();
    f.adapter.push.mockImplementationOnce(async () => {
      throw new PushConflictError([remote(1, { title: "theirs" })]);
    });
    await f.writeLocally(local("e1", "update", { title: "mine" }));
    f.notifyOutboxChanged();
    await vi.waitFor(() => expect(resolveConflict).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.rows.get("1")).toEqual({ id: 1, title: "theirs" }));
    expect(await f.store.getPendingEvents()).toEqual([]);
    expect(await f.store.getRevision(key)).toBe(1);
    f.stop();
  });

  test(`${scope}: a push conflict can lower the stored revision to the server's`, async () => {
    const resolveConflict = vi.fn(() => "local" as const);
    const { f, hold } = await started(scope, { resolveConflict });
    hold();
    await f.store.upsertRevision({ ...key, rev: 9 });
    f.adapter.push.mockImplementationOnce(async () => {
      throw new PushConflictError([remoteDelete(0)]);
    });
    await f.writeLocally(local("e1", "create", { title: "again" }));
    f.notifyOutboxChanged();
    await vi.waitFor(() => expect(f.pushed.at(-1)).toMatchObject([{ rev: 1 }]));
    f.stop();
  });

  test(`${scope}: a push conflict already decided by a pull is only pushed again`, async () => {
    const resolveConflict = vi.fn(() => "local" as const);
    const { f, hold } = await started(scope, { resolveConflict });
    hold();
    await f.store.upsertRevision({ ...key, rev: 4 });
    f.adapter.push.mockImplementationOnce(async () => {
      throw new PushConflictError([remote(4)]);
    });
    await f.writeLocally(local("e1", "update", { title: "mine" }));
    f.notifyOutboxChanged();
    await vi.waitFor(() => expect(f.pushed.at(-1)).toMatchObject([{ rev: 5 }]));
    expect(resolveConflict).not.toHaveBeenCalled();
    expect(f.onRemoteChangesCommitted).not.toHaveBeenCalled();
    f.stop();
  });

  test(`${scope}: a push conflict over a record with no pending writes just applies it`, async () => {
    const resolveConflict = vi.fn(() => "local" as const);
    const { f, hold } = await started(scope, { resolveConflict });
    hold();
    f.adapter.push.mockImplementationOnce(async ({ events, commitChanges }: any) => {
      await commitChanges({ events });
      throw new PushConflictError([remote(3, { title: "theirs" })]);
    });
    await f.writeLocally(local("e1", "update", { title: "mine" }));
    f.notifyOutboxChanged();
    await vi.waitFor(() => expect(f.rows.get("1")).toEqual({ id: 1, title: "theirs" }));
    expect(resolveConflict).not.toHaveBeenCalled();
    expect(await f.store.getRevision(key)).toBe(3);
    f.stop();
  });

  test(`${scope}: a push conflict releases the parked events of its record only`, async () => {
    const onPushRejected = vi.fn();
    const { f, hold } = await started(scope, { onPushRejected });
    hold();
    f.adapter.push.mockImplementation(async () => {
      throw new PushRejectedError("refused");
    });
    await f.writeLocally(local("e1", "update", { title: "one" }));
    await f.writeLocally(local("e2", "update", { title: "two" }, "2"));
    f.notifyOutboxChanged();
    await vi.waitFor(() => expect(onPushRejected).toHaveBeenCalledTimes(2));

    f.adapter.push.mockImplementationOnce(async () => {
      throw new PushConflictError([remote(5)]);
    });
    f.adapter.push.mockImplementation(async ({ events, commitChanges }: any) => {
      if (events.some(({ eventId }: any) => eventId === "e2")) {
        throw new PushRejectedError("refused");
      }
      await commitChanges({ events });
    });
    f.retryRejectedPushes();
    await vi.waitFor(async () =>
      expect((await f.store.getPendingEvents()).map(({ id }) => id)).toEqual(["e2"]),
    );
    expect(await f.store.getRevision(key)).toBe(6);
    f.stop();
  });

  test(`${scope}: a handler that lost leadership leaves a push conflict to the new leader`, async () => {
    let leads = true;
    const resolveConflict = vi.fn(() => "remote" as const);
    const { f, hold } = await started(scope, { resolveConflict, canCommit: () => leads });
    hold();
    f.adapter.push.mockImplementationOnce(async () => {
      leads = false;
      throw new PushConflictError([remote(5)]);
    });
    await f.writeLocally(local("e1", "update", { title: "mine" }));
    f.notifyOutboxChanged();
    await vi.waitFor(() => expect(f.adapter.push).toHaveBeenCalledOnce());
    await settle();
    expect(resolveConflict).not.toHaveBeenCalled();
    expect(await f.store.getRevision(key)).toBeUndefined();
    expect((await f.store.getPendingEvents()).map(({ id }) => id)).toEqual(["e1"]);
    f.stop();
  });

  test(`${scope}: a resolver failing on a push conflict retries the push`, async () => {
    const resolveConflict = vi
      .fn<() => "local">()
      .mockImplementationOnce(() => {
        throw new Error("resolver failed");
      })
      .mockImplementation(() => "local");
    const { f, hold } = await started(scope, { resolveConflict });
    hold();
    f.adapter.push
      .mockImplementationOnce(async () => {
        throw new PushConflictError([remote(5)]);
      })
      .mockImplementationOnce(async () => {
        throw new PushConflictError([remote(5)]);
      });
    await f.writeLocally(local("e1", "update", { title: "mine" }));
    f.notifyOutboxChanged();
    await vi.waitFor(() => expect(f.pushed.at(-1)).toMatchObject([{ rev: 6 }]), { timeout: 2_000 });
    expect(f.onSyncError).toHaveBeenCalledOnce();
    f.stop();
  });

  test(`${scope}: a conflict during a split stops it, so discarded writes are never pushed`, async () => {
    const resolveConflict = vi.fn(() => "remote" as const);
    const { f, hold } = await started(scope, { resolveConflict });
    hold();
    const refuse = async () => {
      throw new PushRejectedError("refused");
    };
    f.adapter.push
      .mockImplementationOnce(refuse)
      .mockImplementationOnce(refuse)
      .mockImplementationOnce(async () => {
        throw new PushConflictError([remote(5)]);
      });
    for (const id of ["e1", "e2", "e3"]) {
      await f.writeLocally(local(id, "update", { title: id }));
    }
    f.notifyOutboxChanged();
    await vi.waitFor(() => expect(resolveConflict).toHaveBeenCalledOnce());
    await settle();
    expect(f.adapter.push).toHaveBeenCalledTimes(3);
    expect(f.pushed).toEqual([]);
    expect(await f.store.getPendingEvents()).toEqual([]);
    expect(await f.store.getRevision(key)).toBe(5);
    f.stop();
  });

  test(`${scope}: a record's writes kept by a conflict during a split are pushed in order`, async () => {
    const resolveConflict = vi.fn(() => "local" as const);
    const { f, hold } = await started(scope, { resolveConflict });
    hold();
    f.adapter.push
      .mockImplementationOnce(async () => {
        throw new PushRejectedError("refused");
      })
      .mockImplementationOnce(async () => {
        throw new PushConflictError([remote(5)]);
      });
    await f.writeLocally(local("e1", "update", { title: "first" }));
    await f.writeLocally(local("e2", "update", { title: "second" }));
    f.notifyOutboxChanged();
    await vi.waitFor(async () => expect(await f.store.getPendingEvents()).toEqual([]));
    expect(f.pushed.flat()).toMatchObject([
      { eventId: "e1", rev: 6 },
      { eventId: "e2", rev: 7 },
    ]);
    f.stop();
  });

  test(`${scope}: a split does not push events replaced since it began`, async () => {
    const { f, hold } = await started(scope);
    hold();
    f.adapter.push
      .mockImplementationOnce(async () => {
        throw new PushRejectedError("refused");
      })
      .mockImplementationOnce(async ({ events, commitChanges }: any) => {
        await f.store.deleteEvents(["e2"]);
        await commitChanges({ events });
      });
    await f.writeLocally(local("e1", "update", { title: "first" }));
    await f.writeLocally(local("e2", "update", { title: "replaced" }));
    f.notifyOutboxChanged();
    await vi.waitFor(async () => expect(await f.store.getPendingEvents()).toEqual([]));
    await settle();
    expect(f.adapter.push).toHaveBeenCalledTimes(2);
    expect(f.pushed).toEqual([]);
    f.stop();
  });

  test(`${scope}: a pulled record is applied again once its revision is forgotten`, async () => {
    const { f, hold, stream } = await started(scope);
    hold();
    await pull(f, stream, [remote(3)]);
    f.rows.delete("1");
    await pull(f, stream, [remote(3)]);
    expect(f.rows.has("1")).toBe(false);

    await f.store.removeRevisions("todos");
    await pull(f, stream, [remote(3)]);
    expect(f.rows.get("1")).toEqual({ id: 1, title: "remote" });
    expect(await f.store.getRevision(key)).toBe(3);
    f.stop();
  });
}
