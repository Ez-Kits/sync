import { afterEach, expect, test, vi } from "vite-plus/test";
import { LeaderChangedError } from "../src/db-storage";
import { isPermanentPushError, PushRejectedError } from "../src/sync-handler";
import { fixture, settle } from "./helpers/sync-fixture";

afterEach(() => {
  vi.useRealTimers();
});

const write = (
  id: string,
  recordId: string,
  title: string,
  type: "create" | "update" = "update",
) => ({
  id,
  type,
  collection: "todos",
  recordId,
  data: { id: Number(recordId), title },
  createdAt: 1,
});

const pendingIds = async (f: ReturnType<typeof fixture>) =>
  (await f.store.getPendingEvents()).map(({ id }) => id);

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

/**
 * A provider whose pushes are atomic, like a Firestore batch or an RTDB multipath update:
 * one containing an event `isBad` accepts reports `error()` and writes none of them.
 */
function atomicProvider(
  f: ReturnType<typeof fixture>,
  isBad: (event: any) => boolean,
  error: () => unknown = () => new PushRejectedError("permission-denied"),
) {
  const log: string[] = [];
  f.adapter.push.mockImplementation(async ({ events, commitChanges }: any) => {
    const ids = events.map((event: any) => event.eventId).join(",");
    if (events.some(isBad)) {
      log.push(`rejected ${ids}`);
      throw error();
    }
    log.push(`accepted ${ids}`);
    await commitChanges({ events });
  });
  return log;
}

/** Let fake timers run the push queue's promise chains without reaching the retry backoff. */
async function flush() {
  for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(1);
}

test("push rejections are recognised by their permanent flag", () => {
  const cause = new Error("denied");
  const error = new PushRejectedError(undefined, { cause });
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("PushRejectedError");
  expect(error.message).toBe("The sync provider rejected the push.");
  expect(error.cause).toBe(cause);
  expect(isPermanentPushError(error)).toBe(true);
  expect(isPermanentPushError({ permanent: true })).toBe(true);
  expect(isPermanentPushError(new Error("offline"))).toBe(false);
  expect(isPermanentPushError({ permanent: "yes" })).toBe(false);
  expect(isPermanentPushError(undefined)).toBe(false);
  expect(isPermanentPushError(null)).toBe(false);
});

for (const scope of ["global", "collection"] as const) {
  test(`${scope}: a rejected event is parked in the outbox; every other event is pushed`, async () => {
    const onPushRejected = vi.fn();
    const onSyncSuccess = vi.fn();
    const f = fixture(scope, { onPushRejected, onSyncSuccess });
    for (const id of ["1", "2", "3", "4"]) await f.writeLocally(write(`e${id}`, id, `t${id}`));
    const rejection = new PushRejectedError("permission-denied");
    const log = atomicProvider(
      f,
      (event) => event.eventId === "e3",
      () => rejection,
    );
    onPushRejected.mockImplementation(({ event }) => log.push(`reported ${event.eventId}`));
    f.start();
    await vi.waitFor(() => expect(log).toContain("accepted e4"));
    await settle();

    expect(log).toEqual([
      "rejected e1,e2,e3,e4",
      "accepted e1,e2",
      "rejected e3,e4",
      "rejected e3",
      "reported e3",
      "accepted e4",
    ]);
    expect(onPushRejected).toHaveBeenCalledExactlyOnceWith({
      event: { type: "update", collection: "todos", data: { id: 3, title: "t3" }, eventId: "e3" },
      error: rejection,
      discard: expect.any(Function),
    });
    expect(f.onSyncError).toHaveBeenCalledWith(rejection);
    // Not synced while an event is parked: the push never reports success.
    expect(onSyncSuccess.mock.calls.length).toBeLessThanOrEqual(1);
    // Nothing is lost: the event and its dirty record stay.
    expect(await pendingIds(f)).toEqual(["e3"]);
    expect(await f.store.getDirtyRecords()).toEqual([
      expect.objectContaining({ recordId: "3", state: "dirty" }),
    ]);
    f.stop();
  });

  test(`${scope}: a signed-out client parks every write and pushes them all, in order, after sign-in`, async () => {
    const onPushRejected = vi.fn();
    const f = fixture(scope, { onPushRejected });
    await f.writeLocally(write("e1", "1", "a", "create"));
    await f.writeLocally(write("e2", "1", "b"));
    await f.writeLocally(write("e3", "2", "c"));
    await f.writeLocally(write("e4", "3", "d"));
    let signedIn = false;
    const log = atomicProvider(f, () => !signedIn);
    f.start();
    await vi.waitFor(() => expect(onPushRejected).toHaveBeenCalledTimes(3));
    await settle();
    // e2 is held behind its record's parked e1; nothing was removed.
    expect(onPushRejected.mock.calls.map(([{ event }]) => event.eventId)).toEqual([
      "e1",
      "e3",
      "e4",
    ]);
    expect(log.some((entry) => entry === "rejected e2")).toBe(false);
    expect(await pendingIds(f)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(await f.store.getDirtyRecords()).toHaveLength(3);

    signedIn = true;
    const before = log.length;
    f.retryRejectedPushes();
    await vi.waitFor(async () => expect(await pendingIds(f)).toEqual([]));
    // The oldest parked event probes alone, then the other parked events, then what they held.
    expect(log.slice(before)).toEqual(["accepted e1", "accepted e3,e4", "accepted e2"]);
    expect(await f.store.getDirtyRecords()).toEqual([]);
    expect(onPushRejected).toHaveBeenCalledTimes(3);
    f.stop();
  });

  test(`${scope}: while signed out, each retry of many parked events is one provider push`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onPushRejected = vi.fn();
    const f = fixture(scope, { onPushRejected });
    const ids = Array.from({ length: 12 }, (_, i) => String(i + 1));
    for (const id of ids) await f.writeLocally(write(`e${id}`, id, `t${id}`));
    await f.writeLocally(write("e13", "1", "later"));
    let signedIn = false;
    const log = atomicProvider(f, () => !signedIn);
    f.start();
    await flush();
    expect(onPushRejected).toHaveBeenCalledTimes(12);

    // Backoff retries, a restart and an explicit retry: one refused probe each, rotating.
    let before = log.length;
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(log.slice(before)).toEqual(["rejected e1"]);
    before = log.length;
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(log.slice(before)).toEqual(["rejected e2"]);
    before = log.length;
    f.retryRejectedPushes();
    await flush();
    expect(log.slice(before)).toEqual(["rejected e3"]);
    before = log.length;
    f.stop();
    f.start();
    await flush();
    expect(log.slice(before)).toEqual(["rejected e4"]);
    expect(onPushRejected).toHaveBeenCalledTimes(12);
    expect(await pendingIds(f)).toHaveLength(13);

    // One retry after sign-in pushes everything, each record in order.
    signedIn = true;
    before = log.length;
    f.retryRejectedPushes();
    await flush();
    expect(log.slice(before)).toEqual([
      "accepted e5",
      `accepted ${["e1", "e2", "e3", "e4", ...ids.slice(5).map((id) => `e${id}`)].join(",")}`,
      "accepted e13",
    ]);
    expect(await pendingIds(f)).toEqual([]);
    expect(f.rows.get("1")).toEqual({ id: 1, title: "later" });
    f.stop();
  });

  test(`${scope}: an accepted probe pushes the other parked events; a refused one stays parked`, async () => {
    const onPushRejected = vi.fn();
    const f = fixture(scope, { onPushRejected });
    for (const id of ["1", "2", "3"]) await f.writeLocally(write(`e${id}`, id, `t${id}`));
    let signedIn = false;
    const log = atomicProvider(f, (event) => !signedIn || event.eventId === "e3");
    f.start();
    await vi.waitFor(() => expect(onPushRejected).toHaveBeenCalledTimes(3));
    await settle();

    signedIn = true;
    const before = log.length;
    f.retryRejectedPushes();
    await vi.waitFor(async () => expect(await pendingIds(f)).toEqual(["e3"]));
    await settle();
    expect(log.slice(before)).toEqual([
      "accepted e1",
      "rejected e2,e3",
      "accepted e2",
      "rejected e3",
    ]);
    expect(onPushRejected).toHaveBeenCalledTimes(3);
    f.stop();
  });

  test(`${scope}: a refused probe moves on to the next parked record on the next retry`, async () => {
    const onPushRejected = vi.fn();
    const f = fixture(scope, { onPushRejected });
    for (const id of ["1", "2", "3"]) await f.writeLocally(write(`e${id}`, id, `t${id}`));
    await f.writeLocally(write("e4", "1", "held"));
    let signedIn = false;
    // e1 can never be written: a true poison.
    const log = atomicProvider(f, (event) => !signedIn || event.eventId === "e1");
    f.start();
    await vi.waitFor(() => expect(onPushRejected).toHaveBeenCalledTimes(3));
    await settle();

    signedIn = true;
    let before = log.length;
    f.retryRejectedPushes();
    await vi.waitFor(() => expect(log.length).toBeGreaterThan(before));
    await settle();
    // The poison probes first and blocks this retry of the others.
    expect(log.slice(before)).toEqual(["rejected e1"]);
    expect(await pendingIds(f)).toEqual(["e1", "e2", "e3", "e4"]);

    before = log.length;
    f.retryRejectedPushes();
    await vi.waitFor(async () => expect(await pendingIds(f)).toEqual(["e1", "e4"]));
    await settle();
    // The next record probes and is accepted; the other parked events follow, narrowed down.
    expect(log.slice(before)).toEqual([
      "accepted e2",
      "rejected e1,e3",
      "rejected e1",
      "accepted e3",
    ]);

    // The next retry starts over from the oldest parked event.
    before = log.length;
    f.retryRejectedPushes();
    await vi.waitFor(() => expect(log.length).toBeGreaterThan(before));
    await settle();
    expect(log.slice(before)).toEqual(["rejected e1"]);
    expect(onPushRejected).toHaveBeenCalledTimes(3);
    f.stop();
  });

  test(`${scope}: a transient failure of the probe retries the probe`, async () => {
    const onPushRejected = vi.fn();
    const f = fixture(scope, { onPushRejected });
    for (const id of ["1", "2"]) await f.writeLocally(write(`e${id}`, id, `t${id}`));
    let signedIn = false;
    const log = atomicProvider(f, () => !signedIn);
    f.start();
    await vi.waitFor(() => expect(onPushRejected).toHaveBeenCalledTimes(2));
    await settle();

    const offline = new Error("unavailable");
    const permanent = f.adapter.push.getMockImplementation()!;
    f.adapter.push.mockImplementationOnce(async () => {
      log.push("offline");
      throw offline;
    });
    f.adapter.push.mockImplementation(permanent);
    signedIn = true;
    const before = log.length;
    f.retryRejectedPushes();
    await vi.waitFor(async () => expect(await pendingIds(f)).toEqual([]));
    expect(log.slice(before)).toEqual(["offline", "accepted e1", "accepted e2"]);
    expect(f.onSyncError).toHaveBeenCalledWith(offline);
    expect(onPushRejected).toHaveBeenCalledTimes(2);
    f.stop();
  });

  test(`${scope}: later events of a parked record are held; discarding lets them go`, async () => {
    const onPushRejected = vi.fn();
    const f = fixture(scope, { onPushRejected });
    await f.writeLocally(write("e1", "1", "invalid", "create"));
    await f.writeLocally(write("e2", "1", "fixed"));
    await f.writeLocally(write("e3", "2", "other"));
    const log = atomicProvider(f, (event) => event.eventId === "e1");
    f.start();
    await vi.waitFor(() => expect(log).toContain("accepted e3"));
    await settle();
    expect(log).toEqual(["rejected e1,e2,e3", "rejected e1,e2", "rejected e1", "accepted e3"]);

    // New writes: another record's goes through, the parked record's waits.
    await f.writeLocally(write("e4", "1", "again"));
    await f.writeLocally(write("e5", "2", "more"));
    f.notifyOutboxChanged();
    await vi.waitFor(() => expect(log).toContain("accepted e5"));
    expect(await pendingIds(f)).toEqual(["e1", "e2", "e4"]);

    const [{ discard }] = onPushRejected.mock.calls[0]!;
    await discard();
    await vi.waitFor(async () => expect(await pendingIds(f)).toEqual([]));
    // Only e1 was discarded; the record's later events are pushed after it, in order.
    expect(log.at(-1)).toBe("accepted e2,e4");
    expect(f.rows.get("1")).toEqual({ id: 1, title: "again" });
    expect(await f.store.getDirtyRecords()).toEqual([]);
    // Discarding again, or an event no longer parked, does nothing.
    await discard();
    expect(log.at(-1)).toBe("accepted e2,e4");
    f.stop();
  });

  test(`${scope}: parked events are retried with a growing backoff, reported once`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onPushRejected = vi.fn();
    const f = fixture(scope, { onPushRejected });
    await f.writeLocally(write("e1", "1", "a"));
    let signedIn = false;
    const log = atomicProvider(f, () => !signedIn);
    f.start();
    await flush();
    expect(log).toEqual(["rejected e1"]);
    expect(onPushRejected).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(log).toEqual(["rejected e1", "rejected e1"]);
    expect(f.onSyncError).toHaveBeenCalledTimes(2);
    expect(onPushRejected).toHaveBeenCalledOnce();

    // The next retry waits twice as long.
    signedIn = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(log).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(log.at(-1)).toBe("accepted e1");
    expect(await pendingIds(f)).toEqual([]);

    // Nothing is parked any more: no further retries.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(log).toHaveLength(3);
    f.stop();
  });

  test(`${scope}: restarting sync retries parked events at once; stopping cancels the backoff`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture(scope, { onPushRejected: vi.fn() });
    await f.writeLocally(write("e1", "1", "a"));
    let signedIn = false;
    const log = atomicProvider(f, () => !signedIn);
    f.start();
    await flush();
    expect(log).toEqual(["rejected e1"]);

    f.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(log).toEqual(["rejected e1"]);

    signedIn = true;
    f.start();
    await flush();
    expect(log).toEqual(["rejected e1", "accepted e1"]);
    expect(await pendingIds(f)).toEqual([]);
    f.stop();
  });

  test(`${scope}: transient failures are retried, never parked`, async () => {
    const onPushRejected = vi.fn();
    const f = fixture(scope, { onPushRejected });
    await f.writeLocally(write("e1", "1", "bad"));
    await f.writeLocally(write("e2", "2", "good"));
    const offline = new Error("unavailable");
    let failNextSingle = true;
    const log = atomicProvider(f, (event) => event.eventId === "e1");
    const permanent = f.adapter.push.getMockImplementation()!;
    // The first push is cut short by the network while e1 is being isolated.
    f.adapter.push.mockImplementation(async (options: any) => {
      if (failNextSingle && options.events.length === 1) {
        failNextSingle = false;
        log.push("offline");
        throw offline;
      }
      return permanent(options);
    });
    f.start();
    await vi.waitFor(() => expect(log).toContain("accepted e2"));

    expect(log).toEqual([
      "rejected e1,e2",
      "offline",
      // Retried after a backoff, from the outbox.
      "rejected e1,e2",
      "rejected e1",
      "accepted e2",
    ]);
    expect(f.onSyncError).toHaveBeenCalledWith(offline);
    expect(onPushRejected).toHaveBeenCalledOnce();
    expect(await pendingIds(f)).toEqual(["e1"]);
    f.stop();
  });

  test(`${scope}: discarding a parked event applies the remote event skipped for its record`, async () => {
    const onPushRejected = vi.fn();
    const f = fixture(scope, { onPushRejected });
    await f.writeLocally(write("e1", "1", "invalid"));
    atomicProvider(f, () => true);
    const held = gate();
    const rejecting = f.adapter.push.getMockImplementation()!;
    f.adapter.push.mockImplementation(async (options: any) => {
      await held.opened;
      return rejecting(options);
    });
    f.start();
    await vi.waitFor(() => expect(f.streams).toHaveLength(1));
    const remote = { type: "update", collection: "todos", data: { id: 1, title: "remote" } };
    f.streams[0]!.options.commitChanges({ changes: [remote], checkpoint: { todos: "c1" } });
    await vi.waitFor(() => expect(f.checkpoints.get("todos")).toBe("c1"));
    held.open();
    await vi.waitFor(() => expect(onPushRejected).toHaveBeenCalledOnce());
    // Parked, not removed: the record still has its pending write.
    expect(f.rows.get("1")?.title).toBe("invalid");

    await onPushRejected.mock.calls[0]![0].discard();
    expect(f.rows.get("1")).toEqual({ id: 1, title: "remote" });
    expect(f.onRemoteChangesCommitted).toHaveBeenCalledExactlyOnceWith([remote]);
    expect(await pendingIds(f)).toEqual([]);
    expect(await f.store.getDirtyRecords()).toEqual([]);
    f.stop();
  });

  test(`${scope}: a failed discard keeps the event; one after losing leadership rejects`, async () => {
    let leader = true;
    const onPushRejected = vi.fn();
    const f = fixture(scope, { onPushRejected, canCommit: () => leader });
    await f.writeLocally(write("e1", "1", "invalid"));
    atomicProvider(f, () => true);
    f.start();
    await vi.waitFor(() => expect(onPushRejected).toHaveBeenCalledOnce());
    const { discard } = onPushRejected.mock.calls[0]![0];

    const failure = new Error("transaction closed");
    f.db.transaction.mockRejectedValueOnce(failure);
    await expect(discard()).rejects.toBe(failure);
    expect(await pendingIds(f)).toEqual(["e1"]);

    leader = false;
    await expect(discard()).rejects.toBeInstanceOf(LeaderChangedError);
    expect(await pendingIds(f)).toEqual(["e1"]);
    f.stop();
  });

  test(`${scope}: a handler that lost leadership neither parks nor reports a rejection`, async () => {
    let leader = true;
    const onPushRejected = vi.fn();
    const f = fixture(scope, { onPushRejected, canCommit: () => leader });
    await f.writeLocally(write("e1", "1", "invalid"));
    const rejection = new PushRejectedError();
    atomicProvider(
      f,
      () => true,
      () => rejection,
    );
    const rejecting = f.adapter.push.getMockImplementation()!;
    const held = gate();
    f.adapter.push.mockImplementation(async (options: any) => {
      await held.opened;
      return rejecting(options);
    });
    f.start();
    await vi.waitFor(() => expect(f.adapter.push).toHaveBeenCalled());
    leader = false;
    held.open();
    await settle();
    expect(onPushRejected).not.toHaveBeenCalled();
    expect(f.onSyncError).not.toHaveBeenCalledWith(rejection);
    expect(await pendingIds(f)).toEqual(["e1"]);
    f.stop();
  });

  test(`${scope}: a parked event that left the outbox otherwise no longer holds its record`, async () => {
    const onPushRejected = vi.fn();
    const f = fixture(scope, { onPushRejected });
    await f.writeLocally(write("e1", "1", "invalid"));
    const log = atomicProvider(f, (event) => event.eventId === "e1");
    f.start();
    await vi.waitFor(() => expect(onPushRejected).toHaveBeenCalledOnce());
    // e.g. a "remote" conflict decision dropped the record's pending writes.
    await f.store.deleteEvents(["e1"]);
    await f.writeLocally(write("e2", "1", "later"));
    f.notifyOutboxChanged();
    await vi.waitFor(() => expect(log).toContain("accepted e2"));
    expect(await pendingIds(f)).toEqual([]);
    f.stop();
  });

  test(`${scope}: a push whose events all left the outbox meanwhile isolates nothing`, async () => {
    const onPushRejected = vi.fn();
    const f = fixture(scope, { onPushRejected });
    await f.writeLocally(write("e1", "1", "a"));
    await f.writeLocally(write("e2", "2", "b"));
    f.adapter.push.mockImplementationOnce(async () => {
      // e.g. "remote" conflict decisions dropped them while the push was in flight.
      await f.store.deleteEvents(["e1", "e2"]);
      throw new PushRejectedError();
    });
    f.start();
    await vi.waitFor(() => expect(f.adapter.push).toHaveBeenCalled());
    await settle();
    expect(f.adapter.push).toHaveBeenCalledOnce();
    expect(onPushRejected).not.toHaveBeenCalled();
    expect(f.onSyncError).not.toHaveBeenCalled();
    f.stop();
  });
}
