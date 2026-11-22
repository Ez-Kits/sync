import { PushConflictError, PushRejectedError } from "@ez-kits/sync-client-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createDurableObjectSyncAdapter, SUBPROTOCOL } from "../../src/client.ts";
import { chunkEvents } from "../../src/client/events.ts";
import type { PushEvent } from "../../src/protocol.ts";
import { FakeServer, flush } from "./fake-server.ts";

const URL = "https://app.test/api/sync";
const todos = { name: "todos", adapterConfig: {}, primaryField: "id" } as const;
const pairs = { name: "pairs", adapterConfig: {}, primaryField: ["a", "b"] } as const;
const notesTable = sqliteTable("notes", { id: text().primaryKey(), title: text() });
const notes = { name: "notes", adapterConfig: { table: notesTable }, primaryField: "id" } as const;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(options: Record<string, unknown> = {}) {
  const server = new FakeServer();
  const auth = { token: "t1" };
  const getToken = vi.fn(async () => auth.token);
  const adapter = createDurableObjectSyncAdapter({
    url: URL,
    collections: [todos, pairs, notes],
    getToken,
    fetch: server.fetch,
    WebSocket: server.WebSocket,
    ...options,
  }) as any;
  const pull = (checkpoint?: Record<string, unknown>, callbacks?: Record<string, unknown>) => {
    const pullOptions = {
      checkpoint,
      commitChanges: vi.fn(),
      ...(callbacks ?? {
        onError: vi.fn(),
        onCaughtUp: vi.fn(),
        onPreviewed: vi.fn(),
        onCount: vi.fn(),
      }),
    } as any;
    const started = adapter.pull(pullOptions) as Promise<() => void>;
    return {
      ...pullOptions,
      stop: async () => (await started)(),
      socket: () => server.allSockets.at(-1)!,
      commits: () => pullOptions.commitChanges.mock.calls.map(([call]: any[]) => call),
    };
  };
  const push = (events: unknown[]) => {
    const commitChanges = vi.fn<(options: { events: unknown[] }) => Promise<void>>(async () => {});
    const result = adapter.push({ events, clientId: "device-1", commitChanges }) as Promise<void>;
    return { commitChanges, result };
  };
  return { server, auth, getToken, adapter, pull, push };
}

const create = (id: string, rev = 1, title = id) => ({
  type: "create",
  collection: "todos",
  data: { id, title },
  eventId: `e-${id}-${rev}`,
  rev,
});

test("the client entry exports the adapter next to the protocol", async () => {
  const entry = await import("../../src/client.ts");
  expect(typeof entry.createDurableObjectSyncAdapter).toBe("function");
  expect(entry.SUBPROTOCOL).toBe("ezsync");
});

test("every collection is synced and revisioned", () => {
  const { adapter } = setup();
  expect(adapter.collections).toEqual(["todos", "pairs", "notes"]);
  expect(adapter.revisionedCollections).toEqual(["todos", "pairs", "notes"]);
  expect(adapter.checkpointSerializer).toBeUndefined();
});

test("a first pull counts, pages everything as full rows with rev, then catches up", async () => {
  const { server, pull } = setup({ countInitialPull: true });
  server.write("todos", "1", { id: "1", title: "a" });
  server.write("todos", "2", { id: "2", title: "b" });
  server.write("todos", "2", null);
  const stream = pull();
  await flush();

  expect(stream.socket().url).toBe(URL);
  expect(stream.socket().protocols).toEqual([SUBPROTOCOL, "t1"]);
  expect(stream.socket().sent).toEqual([
    { type: "pull", checkpoints: { todos: null, pairs: null, notes: null }, count: true },
  ]);
  expect(stream.onCount).toHaveBeenCalledWith({ collection: "todos", total: 2 });
  expect(stream.onCount).toHaveBeenCalledWith({ collection: "pairs", total: 0 });
  expect(stream.commits()).toEqual([
    {
      changes: [
        { type: "update", collection: "todos", data: { id: "1", title: "a" }, rev: 1 },
        { type: "delete", collection: "todos", id: "2", rev: 2 },
      ],
      // The last page saves its checkpoint with `caught-up`.
      checkpoint: {},
    },
    { changes: [], checkpoint: { todos: 3 } },
  ]);
  expect(stream.onCaughtUp).toHaveBeenCalledOnce();
  expect(stream.onError).not.toHaveBeenCalled();
  await stream.stop();
  expect(stream.socket().closed).toBe(true);
});

test("pages that ask for more save their checkpoint and pull the next page from it", async () => {
  const { server, pull } = setup();
  server.pageSize = 2;
  for (const id of ["1", "2", "3", "4", "5"]) server.write("todos", id, { id, title: id });
  const stream = pull({ todos: 0, pairs: 0, notes: 0 });
  await flush();

  expect(stream.socket().sent.map((message: any) => message.checkpoints?.todos)).toEqual([0, 2, 4]);
  expect(stream.commits().map((commit: any) => [commit.changes.length, commit.checkpoint])).toEqual(
    [
      [2, { todos: 2 }],
      [2, { todos: 4 }],
      [1, {}],
      [0, { todos: 5 }],
    ],
  );
  expect(stream.onCaughtUp).toHaveBeenCalledOnce();
});

test("live changes commit with their checkpoint once caught up", async () => {
  const { server, pull } = setup();
  const stream = pull({ todos: 0, pairs: 0, notes: 0 });
  await flush();
  server.write("todos", "1", { id: "1", title: "a" });
  await flush();
  expect(stream.commits().at(-1)).toEqual({
    changes: [{ type: "update", collection: "todos", data: { id: "1", title: "a" }, rev: 1 }],
    checkpoint: { todos: 1 },
  });
  expect(stream.onCaughtUp).toHaveBeenCalledOnce();
});

test("a poke pulls from the saved checkpoints and a live commit meanwhile saves none", async () => {
  const { server, pull } = setup();
  server.pokeAbove = 1;
  server.manualOpen = true;
  const stream = pull({ todos: 0, pairs: 0, notes: 0 });
  await flush();
  const socket = stream.socket();
  socket.emit("open");

  // A poke while the pull is in flight is answered by that pull.
  socket.deliver({ type: "poke" });
  expect(socket.sent).toHaveLength(1);
  await flush();

  server.push(
    {
      requestId: "other",
      events: [create("1"), create("2")].map((event) => ({ ...event, id: event.data.id })) as never,
    },
    "http",
  );
  // A small commit that lands right after the poke, before the poke's pull is answered.
  socket.deliver({
    type: "changes",
    changes: [{ collection: "todos", id: "9", seq: 9, rev: 1, deleted: false, data: { id: "9" } }],
    checkpoints: { todos: 9 },
    hasMore: false,
  });
  expect(socket.sent.at(-1)).toEqual({
    type: "pull",
    checkpoints: { todos: 0, pairs: 0, notes: 0 },
  });
  await flush();
  const commits = stream.commits().slice(-3);
  expect(commits.map((commit: any) => commit.checkpoint)).toEqual([{}, {}, { todos: 9 }]);
  expect(commits[1].changes).toHaveLength(2);
  expect(stream.onCaughtUp).toHaveBeenCalledOnce();
});

test("a checkpoint that isn't a number pulls that collection from the start", async () => {
  const { pull } = setup();
  const stream = pull({ todos: { syncedAt: 5, id: "x" }, pairs: 3 });
  await flush();
  expect(stream.socket().sent[0]).toEqual({
    type: "pull",
    checkpoints: { todos: null, pairs: 3, notes: null },
  });
});

test("a preview of the collections pulled for the first time goes before the pull", async () => {
  const { server, pull } = setup({
    preview: { limit: 1, orderBy: { todos: { column: "title", direction: "asc" } } },
  });
  server.write("todos", "1", { id: "1", title: "b" });
  server.write("todos", "2", { id: "2", title: "a" });
  server.write("notes", "n", { id: "n", title: "x" });
  server.write("notes", "n", null);
  const stream = pull({ pairs: 4 });
  await flush();

  expect(stream.socket().sent[0]).toEqual({
    type: "preview",
    collections: { todos: { column: "title", direction: "asc" }, notes: null },
    limit: 1,
  });
  expect(stream.socket().sent[1].type).toBe("pull");
  expect(stream.commits()[0]).toEqual({
    changes: [{ type: "update", collection: "todos", data: { id: "2", title: "a" }, rev: 1 }],
    checkpoint: {},
    preview: true,
  });
  expect(stream.onPreviewed.mock.calls).toEqual([
    [{ collection: "todos", hasData: true }],
    [{ collection: "notes", hasData: false }],
  ]);
});

test("the preview is newest first without orderBy and skipped when every collection has a checkpoint", async () => {
  const { server, pull } = setup({ preview: { limit: 1 } });
  server.write("todos", "1", { id: "1", title: "a" });
  server.write("todos", "2", { id: "2", title: "b" });
  const first = pull();
  await flush();
  expect((first.socket().sent[0] as any).collections).toEqual({
    todos: null,
    pairs: null,
    notes: null,
  });
  expect(first.commits()[0].changes[0].data.id).toBe("2");
  await first.stop();

  const resumed = pull({ todos: 2, pairs: 0, notes: 0 });
  await flush();
  expect(resumed.socket().sent.map((message: any) => message.type)).toEqual(["pull"]);
});

test("pulled rows drop columns their Drizzle table lacks; other collections keep every field", async () => {
  const { server, pull } = setup();
  server.write("notes", "n", { id: "n", title: "x", addedLater: 1 });
  server.write("todos", "t", { id: "t", title: "y", addedLater: 1 });
  const stream = pull();
  await flush();
  expect(stream.commits()[0].changes.map((change: any) => change.data)).toEqual([
    { id: "n", title: "x" },
    { id: "t", title: "y", addedLater: 1 },
  ]);
});

test("a composite key is pushed as its JSON array and a pulled delete decodes it", async () => {
  const { server, pull, push } = setup();
  const { commitChanges, result } = push([
    { type: "create", collection: "pairs", data: { a: "x", b: 1, v: 1 }, eventId: "p1", rev: 1 },
    { type: "delete", collection: "pairs", id: { a: "x", b: 1 }, eventId: "p2", rev: 2 },
  ]);
  await result;
  expect(commitChanges).toHaveBeenCalledOnce();
  expect(server.pushes[0]!.request.events.map((event) => event.id)).toEqual(['["x",1]', '["x",1]']);
  const stream = pull();
  await flush();
  expect(stream.commits()[0].changes).toEqual([
    { type: "delete", collection: "pairs", id: { a: "x", b: 1 }, rev: 2 },
  ]);
});

test("pushes go over the open socket and over HTTP otherwise, with the token", async () => {
  const { server, pull, push } = setup();
  const offline = push([create("1")]);
  await offline.result;
  expect(server.pushes.at(-1)!.via).toBe("http");
  expect(server.httpRequests[0]).toMatchObject({
    url: `${URL}/push`,
    headers: { authorization: "Bearer t1", "content-type": "application/json" },
  });
  expect(server.pushes[0]!.request.events[0]).toEqual({
    eventId: "e-1-1",
    collection: "todos",
    type: "create",
    id: "1",
    rev: 1,
    data: { id: "1", title: "1" },
  });
  expect(offline.commitChanges).toHaveBeenCalledWith({ events: [create("1")] });

  const stream = pull();
  await flush();
  const online = push([{ ...create("1", 2), type: "update" }]);
  await online.result;
  expect(server.pushes.at(-1)!.via).toBe("socket");
  expect(online.commitChanges).toHaveBeenCalledOnce();
  await stream.stop();

  await push([create("1", 3)]).result;
  expect(server.pushes.at(-1)!.via).toBe("http");
});

test("a push whose socket reply is lost times out and its retry is applied once", async () => {
  vi.useFakeTimers();
  const { server, pull, push } = setup();
  const stream = pull();
  await flush();
  server.loseNextReply = true;
  const lost = push([create("1")]);
  const failure = expect(lost.result).rejects.toThrow("no reply in time");
  await vi.advanceTimersByTimeAsync(30_000);
  await failure;
  expect(lost.commitChanges).not.toHaveBeenCalled();
  // A reply arriving after the timeout is ignored.
  stream.socket().deliver({
    type: "push-result",
    requestId: server.pushes[0]!.request.requestId,
    reply: { ok: true, applied: [] },
  });

  const retry = push([create("1")]);
  await retry.result;
  expect(retry.commitChanges).toHaveBeenCalledOnce();
  expect(server.seq).toBe(1);
});

test("a push whose HTTP reply is lost is retried and applied once", async () => {
  const { server, push } = setup();
  server.loseNextReply = true;
  await expect(push([create("1")]).result).rejects.toThrow("network error");
  await push([create("1")]).result;
  expect(server.seq).toBe(1);
  expect(server.records.size).toBe(1);
  expect(server.pushes.map(({ request }) => request.clientId)).toEqual(["device-1", "device-1"]);
});

test("a socket closing mid-push fails the push for a retry", async () => {
  const { pull, push } = setup();
  const stream = pull();
  await flush();
  const { result } = push([create("1")]);
  stream.socket().serverClose(1006);
  await expect(result).rejects.toThrow("closed before the push was answered");
  expect(stream.onError).toHaveBeenCalledWith(new Error("The sync socket closed (1006)."));
});

test("a conflict throws PushConflictError with the server's rows and tombstones", async () => {
  const { server, push } = setup();
  server.write("todos", "1", { id: "1", title: "theirs", extra: true });
  server.write("notes", "n", { id: "n", title: "x", extra: true });
  server.write("notes", "n", null);
  const { result, commitChanges } = push([
    create("1"),
    { type: "update", collection: "notes", data: { id: "n", title: "mine" }, eventId: "n", rev: 2 },
  ]);
  const error = await result.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PushConflictError);
  expect((error as PushConflictError).events).toEqual([
    {
      type: "update",
      collection: "todos",
      data: { id: "1", title: "theirs", extra: true },
      rev: 1,
    },
    { type: "delete", collection: "notes", id: "n", rev: 2 },
  ]);
  expect(commitChanges).not.toHaveBeenCalled();
});

test("a rejection throws a permanent PushRejectedError with its code", async () => {
  const { server, push } = setup();
  server.reject = (event) => (event.id === "bad" ? "invalid-argument" : undefined);
  const error = await push([create("bad")]).result.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PushRejectedError);
  expect(error).toMatchObject({ permanent: true, code: "invalid-argument" });
  expect((error as Error).message).toContain("invalid-argument");
});

test("an expired token on the socket is refreshed with an auth message; pushes use HTTP meanwhile", async () => {
  const { server, auth, getToken, pull, push } = setup();
  const stream = pull();
  await flush();
  const socket = stream.socket();
  server.tokens = new Set(["t2"]);
  auth.token = "t2";

  // A socket push with the expired token: refresh, then retry.
  const expired = push([create("1")]);
  await expect(expired.result).rejects.toThrow("token expired");
  expect(socket.sent.at(-1)).toEqual({ type: "auth", token: "t2" });
  await push([create("1")]).result;
  expect(server.pushes.at(-1)!.via).toBe("socket");

  // The server asks for a token: until `auth` is sent, pushes go over HTTP.
  socket.deliver({ type: "unauthenticated" });
  const during = push([create("2")]);
  await during.result;
  expect(server.pushes.at(-1)!.via).toBe("http");
  await flush();
  expect(socket.sent.at(-1)).toEqual({ type: "auth", token: "t2" });
  expect(getToken).toHaveBeenCalledTimes(4);
  await push([create("3")]).result;
  expect(server.pushes.at(-1)!.via).toBe("socket");
});

test("an expired token over HTTP is refreshed and the push retried", async () => {
  const { server, auth, getToken, push } = setup();
  server.tokens = new Set(["t2"]);
  await expect(push([create("1")]).result).rejects.toThrow("token expired");
  expect(getToken).toHaveBeenCalledTimes(2);
  auth.token = "t2";
  await push([create("1")]).result;
  expect(server.records.size).toBe(1);
});

test("a token refresh that fails ends the stream", async () => {
  const { getToken, pull } = setup();
  const stream = pull();
  await flush();
  getToken.mockRejectedValueOnce(new Error("signed out"));
  stream.socket().deliver({ type: "unauthenticated" });
  await flush();
  expect(stream.onError).toHaveBeenCalledWith(new Error("signed out"));

  // A refresh that fails after the socket closed reports only the close.
  const closing = pull();
  await flush();
  let rejectToken!: (error: Error) => void;
  getToken.mockImplementationOnce(() => new Promise((_, reject) => (rejectToken = reject)));
  closing.socket().deliver({ type: "unauthenticated" });
  closing.socket().serverClose(1006);
  rejectToken(new Error("signed out"));
  await flush();
  expect(closing.onError).toHaveBeenCalledExactlyOnceWith(
    new Error("The sync socket closed (1006)."),
  );
});

test("close 4001 is temporary, close 4410 permanent, and a socket error reports once", async () => {
  const { pull } = setup();
  const expired = pull();
  await flush();
  expired.socket().serverClose(4001);
  const temporary = expired.onError.mock.calls[0][0];
  expect(temporary.message).toContain("4001");
  expect(temporary.permanent).toBeUndefined();

  const deleted = pull();
  await flush();
  deleted.socket().serverClose(4410);
  expect(deleted.onError.mock.calls[0][0]).toMatchObject({
    permanent: true,
    code: "scope-deleted",
  });

  const broken = pull();
  await flush();
  broken.socket().emit("error");
  broken.socket().serverClose(1006);
  expect(broken.onError).toHaveBeenCalledExactlyOnceWith(new Error("The sync socket failed."));
});

test("a malformed message fails the stream, and nothing is handled after it stops", async () => {
  const { pull } = setup();
  const stream = pull();
  await flush();
  stream.socket().deliver("not json");
  expect(stream.onError).toHaveBeenCalledOnce();
  stream.socket().deliver({ type: "caught-up" });

  const stopped = pull();
  await flush();
  const commits = stopped.commits().length;
  await stopped.stop();
  stopped.socket().emit("message", { data: JSON.stringify({ type: "caught-up" }) });
  stopped.socket().emit("close", { code: 1000 });
  expect(stopped.commits()).toHaveLength(commits);
  expect(stopped.onError).not.toHaveBeenCalled();
});

test("without a WebSocket the pull polls over HTTP", async () => {
  vi.useFakeTimers();
  const { server, pull, push } = setup({ pollIntervalMs: 1_000 });
  server.noSockets = true;
  server.pageSize = 1;
  server.write("todos", "1", { id: "1", title: "a" });
  server.write("todos", "2", { id: "2", title: "b" });
  const stream = pull({ todos: { firestore: true } });
  await flush();
  expect(server.httpRequests[0]).toMatchObject({
    url: `${URL}/pull`,
    headers: { authorization: "Bearer t1" },
    body: { type: "pull", checkpoints: { todos: null, pairs: null, notes: null } },
  });
  expect(stream.commits().map((commit: any) => commit.checkpoint)).toEqual([
    { todos: 1 },
    { todos: 2 },
  ]);
  expect(stream.onCaughtUp).toHaveBeenCalledOnce();

  await push([create("3")]).result;
  expect(server.pushes.at(-1)!.via).toBe("http");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(stream.commits().at(-1).checkpoint).toEqual({ todos: 3 });
  expect(stream.onCaughtUp).toHaveBeenCalledOnce();

  server.httpStatus = 503;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(stream.onError).toHaveBeenCalledWith(new Error("The sync server answered 503."));
  await stream.stop();
});

test("a stopped poll commits nothing and reports nothing", async () => {
  const { server, pull } = setup();
  server.noSockets = true;
  const answered = pull();
  await answered.stop();
  await flush();
  expect(answered.commitChanges).not.toHaveBeenCalled();

  server.httpStatus = 500;
  const failed = pull();
  await failed.stop();
  await flush();
  expect(failed.onError).not.toHaveBeenCalled();
});

test("callbacks other than commitChanges are optional", async () => {
  const { server, getToken, pull } = setup({ preview: { limit: 5 }, countInitialPull: true });
  server.write("todos", "1", { id: "1" });
  const stream = pull(undefined, {});
  await flush();
  expect(stream.commits()).toHaveLength(3);
  getToken.mockRejectedValueOnce(new Error("signed out"));
  stream.socket().deliver({ type: "unauthenticated" });
  await flush();

  server.noSockets = true;
  server.httpStatus = 500;
  const polled = pull(undefined, {});
  await flush();
  server.httpStatus = undefined;
  const polledOk = pull(undefined, {});
  await flush();
  expect(polled.commits()).toHaveLength(0);
  expect(polledOk.commits()).toHaveLength(1);
  await polledOk.stop();
});

test("the global fetch and WebSocket are the defaults", async () => {
  const server = new FakeServer();
  vi.stubGlobal("fetch", server.fetch);
  vi.stubGlobal("WebSocket", server.WebSocket);
  const adapter = createDurableObjectSyncAdapter({
    url: URL,
    collections: [todos],
    getToken: () => "t1",
  }) as any;
  await adapter.push({ events: [create("1")], commitChanges: async () => {} });
  expect(server.pushes).toHaveLength(1);
  const stop = await adapter.pull({ commitChanges: () => {} });
  await flush();
  expect(server.allSockets).toHaveLength(1);
  stop();
});

test("pushes split by event count and acknowledge each request", async () => {
  const { server, push } = setup({ pushLimits: { events: 2 } });
  const events = ["1", "2", "3", "4", "5"].map((id) => create(id));
  const { commitChanges, result } = push(events);
  await result;
  expect(server.pushes.map(({ request }) => request.events.length)).toEqual([2, 2, 1]);
  expect(commitChanges.mock.calls.map(([call]) => call.events)).toEqual([
    events.slice(0, 2),
    events.slice(2, 4),
    events.slice(4),
  ]);
  expect(new Set(server.pushes.map(({ request }) => request.requestId)).size).toBe(3);
});

test("pushes split by bytes, and one event over the cap is rejected after the ones before it", async () => {
  const { server, push } = setup({ pushLimits: { bytes: 400 } });
  const events = [create("1", 1, "a".repeat(100)), create("2", 1, "b".repeat(100))];
  const huge = create("3", 1, "c".repeat(400));
  const { commitChanges, result } = push([...events, huge, create("4")]);
  const error = await result.catch((caught: unknown) => caught);
  expect(server.pushes.map(({ request }) => request.events.length)).toEqual([1, 1]);
  expect(commitChanges).toHaveBeenCalledTimes(2);
  expect(error).toBeInstanceOf(PushRejectedError);
  expect(error).toMatchObject({ code: "too-large" });
});

test("chunks are measured in UTF-8 bytes", () => {
  const event = (title: string): PushEvent => ({
    eventId: "e",
    collection: "t",
    type: "create",
    id: "1",
    rev: 1,
    data: { title },
  });
  const encoder = new (globalThis as any).TextEncoder();
  const bytes = (value: PushEvent) => encoder.encode(JSON.stringify(value)).length + 1;
  const events = [event("é€😀"), event("é€😀"), event("x")];
  // The first two fit exactly.
  const cap = 128 + bytes(events[0]!) + bytes(events[1]!);
  expect(chunkEvents(events, { events: 500, bytes: cap })).toEqual([
    { start: 0, end: 2, tooLarge: false },
    { start: 2, end: 3, tooLarge: false },
  ]);
  expect(chunkEvents([], { events: 500, bytes: cap })).toEqual([]);
});

test("the open socket sends PING on an interval, ignores PONG and stops on close and cleanup", async () => {
  vi.useFakeTimers();
  const { pull } = setup({ pingIntervalMs: 1_000 });
  const closed = pull();
  await flush();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(closed.socket().pings).toBe(2);
  expect(closed.onError).not.toHaveBeenCalled();
  closed.socket().serverClose(1006);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(closed.socket().pings).toBe(2);

  const stopped = pull();
  await flush();
  await stopped.stop();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(stopped.socket().pings).toBe(0);
});

test("a pulled delete decodes a Drizzle number key to a number; composite keys keep their types", async () => {
  const counters = sqliteTable("counters", { id: integer().primaryKey() });
  const ids = { name: "counters", adapterConfig: { table: counters }, primaryField: "id" } as const;
  const { server, pull } = setup({ collections: [ids, notes, pairs] });
  server.write("counters", "5", { id: 5 });
  server.write("counters", "5", null);
  server.write("notes", "7", { id: "7" });
  server.write("notes", "7", null);
  server.write("pairs", '["x",2]', { a: "x", b: 2 });
  server.write("pairs", '["x",2]', null);
  const stream = pull();
  await flush();
  expect(stream.commits()[0].changes.map((change: any) => change.id)).toEqual([
    5,
    "7",
    { a: "x", b: 2 },
  ]);
});

test("three sockets in a row that never open switch the pull to polling, which retries a socket", async () => {
  vi.useFakeTimers();
  const { server, pull } = setup();
  server.manualOpen = true;
  server.write("todos", "1", { id: "1", title: "a" });

  const first = pull();
  await flush();
  first.socket().serverClose(1006);
  expect(first.onError).toHaveBeenCalledOnce();
  const second = pull();
  await flush();
  second.socket().emit("error");
  second.socket().serverClose(1006);
  expect(second.onError).toHaveBeenCalledOnce();

  const third = pull();
  await flush();
  third.socket().serverClose(1006);
  await flush();
  expect(third.onError).not.toHaveBeenCalled();
  expect(server.httpRequests.at(-1)!.url).toBe(`${URL}/pull`);
  expect(third.onCaughtUp).toHaveBeenCalledOnce();

  // A new stream polls right away.
  const sockets = server.allSockets.length;
  const fourth = pull();
  await flush();
  expect(server.allSockets).toHaveLength(sockets);
  expect(fourth.commits()).toHaveLength(1);
  await fourth.stop();

  // Five minutes later the third stream tries a socket again; once open, polling stops.
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(server.allSockets).toHaveLength(sockets + 1);
  third.socket().emit("open");
  await flush();
  expect(third.socket().sent[0]!.type).toBe("pull");
  const requests = server.httpRequests.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(server.httpRequests).toHaveLength(requests);
  expect(third.onCaughtUp).toHaveBeenCalledOnce();

  // The open reset the count: the next socket that never opens reports an error again.
  third.socket().serverClose(1006);
  const fifth = pull();
  await flush();
  fifth.socket().serverClose(1006);
  expect(fifth.onError).toHaveBeenCalledOnce();
  await third.stop();
});

test("a socket retry from polling reports a token failure, unless the stream stopped", async () => {
  vi.useFakeTimers();
  // Polls less often than sockets are retried, so each retry asks for the next token.
  const { server, getToken, pull } = setup({ pollIntervalMs: 10 * 60_000 });
  server.manualOpen = true;
  for (let i = 0; i < 2; i += 1) {
    pull();
    await flush();
    server.allSockets.at(-1)!.serverClose(1006);
  }
  const polling = pull();
  await flush();
  polling.socket().serverClose(1006);
  await flush();
  getToken.mockRejectedValueOnce(new Error("signed out"));
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(polling.onError).toHaveBeenCalledWith(new Error("signed out"));

  const stoppedDuringToken = pull();
  await flush();
  let resolveToken!: (token: string) => void;
  getToken.mockImplementationOnce(() => new Promise((resolve) => (resolveToken = resolve)));
  const sockets = server.allSockets.length;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  await stoppedDuringToken.stop();
  resolveToken("t1");
  await flush();
  expect(server.allSockets).toHaveLength(sockets);

  const stoppedThenFailed = pull();
  await flush();
  let rejectToken!: (error: Error) => void;
  getToken.mockImplementationOnce(() => new Promise((_, reject) => (rejectToken = reject)));
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  await stoppedThenFailed.stop();
  rejectToken(new Error("late"));
  await flush();
  expect(stoppedThenFailed.onError).not.toHaveBeenCalled();
});
