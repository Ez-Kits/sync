import { afterEach, expect, test, vi } from "vite-plus/test";
import { ChangeBus } from "../src/change-bus";
import { SyncClientImpl } from "../src/sync-client/sync-client";
import { atomicMemoryStore, clientConfig, makeDb, tick } from "./helpers/storage";

function setup(store = atomicMemoryStore()) {
  const db = makeDb(undefined, store);
  const client = new SyncClientImpl(clientConfig(db), new ChangeBus<any>()) as any;
  const change = () => client.collections.todos.insert({ id: crypto.randomUUID() });
  return { client, db, change };
}

/** A query whose runs are settled by hand, in any order. */
function manualQuery<T>() {
  const runs: { resolve: (value: T) => void; reject: (error: unknown) => void }[] = [];
  const query = vi.fn(
    () => new Promise<T>((resolve, reject) => void runs.push({ resolve, reject })),
  );
  return { query, runs };
}

/** What `fn` left as unhandled rejections, kept from the test runner's own listener. */
async function unhandledRejections(fn: () => Promise<void>): Promise<unknown[]> {
  const listeners = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const seen: unknown[] = [];
  const capture = (reason: unknown) => void seen.push(reason);
  process.on("unhandledRejection", capture);
  try {
    await fn();
    await tick();
  } finally {
    process.off("unhandledRejection", capture);
    for (const listener of listeners) process.on("unhandledRejection", listener);
  }
  return seen;
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("an older run finishing last does not overwrite newer data", async () => {
  const { client, change } = setup();
  const { query, runs } = manualQuery<string>();
  const onData = vi.fn();
  client.liveQuery({ query, onData });
  await tick();
  await change();
  await tick();
  runs[1]?.resolve("new");
  await tick();
  runs[0]!.resolve("old");
  await tick();
  runs[1]?.resolve("new");
  await tick();
  expect(onData.mock.lastCall).toEqual(["new"]);
  await client.dispose();
});

test("changes during a run start exactly one follow-up", async () => {
  const { client, change } = setup();
  const { query, runs } = manualQuery<number>();
  const onData = vi.fn();
  client.liveQuery({ query, onData });
  await tick();
  await change();
  await change();
  await change();
  await tick();
  expect(query).toHaveBeenCalledOnce();
  runs[0]!.resolve(1);
  await tick();
  expect(query).toHaveBeenCalledTimes(2);
  runs[1]!.resolve(2);
  await tick();
  expect(query).toHaveBeenCalledTimes(2);
  expect(onData.mock.calls).toEqual([[1], [2]]);
  await client.dispose();
});

test("continuous changes do not starve delivery", async () => {
  const { client, change } = setup();
  const { query, runs } = manualQuery<number>();
  const onData = vi.fn();
  client.liveQuery({ query, onData });
  await tick();
  for (let run = 0; run < 4; run += 1) {
    // Each run is overtaken by another change before it finishes.
    await change();
    await tick();
    runs[run]!.resolve(run);
    await tick();
  }
  expect(onData.mock.calls).toEqual([[0], [1], [2], [3]]);
  await client.dispose();
});

test("an unchanged result is not delivered again, and a changed one is", async () => {
  const { client, change } = setup();
  let rows = [{ id: 1, at: new Date(5) }];
  const query = vi.fn(async () => rows.map((row) => ({ ...row, at: new Date(row.at) })));
  const onData = vi.fn();
  client.liveQuery({ query, onData });
  await tick();
  expect(onData).toHaveBeenCalledOnce();

  await change();
  await tick();
  expect(query).toHaveBeenCalledTimes(2);
  expect(onData).toHaveBeenCalledOnce();

  rows = [{ id: 1, at: new Date(6) }];
  await change();
  await tick();
  expect(onData).toHaveBeenCalledTimes(2);
  await client.dispose();
});

test("the first result is delivered even when undefined", async () => {
  const { client } = setup();
  const onData = vi.fn();
  client.liveQuery({ query: async () => undefined, onData });
  await tick();
  expect(onData).toHaveBeenCalledExactlyOnceWith(undefined);
  await client.dispose();
});

test("isEqual decides what counts as a change", async () => {
  const { client, change } = setup();
  let version = 0;
  const onData = vi.fn();
  const isEqual = vi.fn((a: { id: number }, b: { id: number }) => a.id === b.id);
  client.liveQuery({ query: async () => ({ id: 1, version: (version += 1) }), onData, isEqual });
  await tick();
  await change();
  await tick();
  expect(isEqual).toHaveBeenCalledOnce();
  expect(onData).toHaveBeenCalledOnce();
  await client.dispose();
});

test("an isEqual that throws fails the run", async () => {
  const { client, change } = setup();
  const failure = new Error("cannot compare");
  const onData = vi.fn();
  const onError = vi.fn();
  client.liveQuery({
    query: async () => 1,
    onData,
    onError,
    isEqual: () => {
      throw failure;
    },
  });
  await tick();
  await change();
  await tick();
  expect(onData).toHaveBeenCalledOnce();
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  await client.dispose();
});

test("a stopped live query delivers nothing further", async () => {
  const { client, change } = setup();
  const first = manualQuery<number>();
  const onData = vi.fn();
  const stop = client.liveQuery({ query: first.query, onData });
  await tick();
  await change();
  await tick();
  stop();
  first.runs[0]!.resolve(1);
  await tick();
  // The change it held back is not run either.
  expect(first.query).toHaveBeenCalledOnce();
  expect(onData).not.toHaveBeenCalled();

  const second = manualQuery<number>();
  const onError = vi.fn();
  const stopSecond = client.liveQuery({ query: second.query, onData, onError });
  await tick();
  stopSecond();
  second.runs[0]!.reject(new Error("late"));
  await tick();
  expect(onError).not.toHaveBeenCalled();
  await client.dispose();
});

test("a failure after stopping is not reported, even without onError", async () => {
  const { client } = setup();
  const { query, runs } = manualQuery<number>();
  const seen = await unhandledRejections(async () => {
    const stop = client.liveQuery({ query, onData: vi.fn() });
    await tick();
    stop();
    runs[0]!.reject(new Error("late"));
    await tick();
  });
  expect(seen).toEqual([]);
  await client.dispose();
});

test("stopping inside onData ends the live query", async () => {
  const { client, change } = setup();
  const { query, runs } = manualQuery<number>();
  const onData = vi.fn(() => stop());
  const stop = client.liveQuery({ query, onData });
  await tick();
  await change();
  await tick();
  runs[0]!.resolve(1);
  await tick();
  expect(onData).toHaveBeenCalledOnce();
  expect(query).toHaveBeenCalledOnce();
  await client.dispose();
});

test("a failed run calls onError and a later change retries", async () => {
  const { client, change } = setup();
  const failure = new Error("query failed");
  const query = vi.fn<() => Promise<string>>().mockRejectedValueOnce(failure);
  query.mockResolvedValue("rows");
  const onData = vi.fn();
  const onError = vi.fn();
  client.liveQuery({ query, onData, onError });
  await tick();
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  expect(onData).not.toHaveBeenCalled();

  await change();
  await tick();
  expect(onData).toHaveBeenCalledExactlyOnceWith("rows");
  await client.dispose();
});

test("the first success after a failure is delivered even when unchanged", async () => {
  const { client, change } = setup();
  const query = vi.fn<() => Promise<string>>().mockResolvedValue("rows");
  const onData = vi.fn();
  const onError = vi.fn();
  client.liveQuery({ query, onData, onError });
  await tick();
  query.mockRejectedValueOnce(new Error("passing"));
  await change();
  await tick();
  expect(onError).toHaveBeenCalledOnce();
  await change();
  await tick();
  expect(onData.mock.calls).toEqual([["rows"], ["rows"]]);
  await change();
  await tick();
  expect(onData).toHaveBeenCalledTimes(2);
  await client.dispose();
});

test("a query that throws synchronously fails the run", async () => {
  const { client } = setup();
  const failure = new Error("sync");
  const onError = vi.fn();
  client.liveQuery({
    query: () => {
      throw failure;
    },
    onData: vi.fn(),
    onError,
  });
  await tick();
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  await client.dispose();
});

test("a rejected initialization reaches onError instead of hanging", async () => {
  const store = atomicMemoryStore();
  const failure = new Error("no tables");
  store.initialize.mockRejectedValue(failure);
  const { client } = setup(store);
  const query = vi.fn(async () => 1);
  const answer = new Promise((resolve, reject) => {
    client.liveQuery({ query, onData: resolve, onError: reject });
  });
  await expect(answer).rejects.toBe(failure);
  expect(query).not.toHaveBeenCalled();
  await client.dispose().catch(() => {});
});

test("a one-time read built on liveQuery settles when its query fails", async () => {
  const { client } = setup();
  const failure = new Error("query failed");
  const readOnce = () =>
    new Promise((resolve, reject) => {
      const stop = client.liveQuery({
        query: async () => {
          throw failure;
        },
        onData: (data: unknown) => {
          stop();
          resolve(data);
        },
        onError: (error: unknown) => {
          stop();
          reject(error);
        },
      });
    });
  await expect(readOnce()).rejects.toBe(failure);
  await client.dispose();
});

test("without onError a failure surfaces as an unhandled rejection and the query keeps working", async () => {
  const { client, change } = setup();
  const failure = new Error("query failed");
  const query = vi.fn<() => Promise<string>>().mockRejectedValueOnce(failure);
  query.mockResolvedValue("rows");
  const onData = vi.fn();
  const seen = await unhandledRejections(async () => {
    client.liveQuery({ query, onData });
    await tick();
  });
  expect(seen).toEqual([failure]);
  await change();
  await tick();
  expect(onData).toHaveBeenCalledExactlyOnceWith("rows");
  await client.dispose();
});

test("an onData that throws is reported, not routed to onError, and does not wedge later runs", async () => {
  const { client, change } = setup();
  const failure = new Error("render failed");
  let value = 0;
  const onData = vi.fn<(data: number) => void>().mockImplementationOnce(() => {
    throw failure;
  });
  const onError = vi.fn();
  const seen = await unhandledRejections(async () => {
    client.liveQuery({ query: async () => (value += 1), onData, onError });
    await tick();
  });
  expect(seen).toEqual([failure]);
  expect(onError).not.toHaveBeenCalled();
  await change();
  await tick();
  expect(onData.mock.calls).toEqual([[1], [2]]);
  await client.dispose();
});

test("an onError that throws is reported and does not wedge later runs", async () => {
  const { client, change } = setup();
  const failure = new Error("toast failed");
  const query = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("query failed"));
  query.mockResolvedValue("rows");
  const onData = vi.fn();
  const seen = await unhandledRejections(async () => {
    client.liveQuery({
      query,
      onData,
      onError: () => {
        throw failure;
      },
    });
    await tick();
  });
  expect(seen).toEqual([failure]);
  await change();
  await tick();
  expect(onData).toHaveBeenCalledExactlyOnceWith("rows");
  await client.dispose();
});

test("query reads once with the adapter's query builder", async () => {
  const { client, db } = setup();
  const read = vi.fn(async () => "rows");
  await expect(client.query(read)).resolves.toBe("rows");
  expect(read).toHaveBeenCalledExactlyOnceWith(db.queryBuilder, db.querySchema);
  await client.dispose();
});

test("query rejects when the read or the initialization fails", async () => {
  const { client } = setup();
  const failure = new Error("query failed");
  await expect(
    client.query(() => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  await client.dispose();

  const store = atomicMemoryStore();
  const startup = new Error("no tables");
  store.initialize.mockRejectedValue(startup);
  const broken = setup(store).client;
  const read = vi.fn();
  await expect(broken.query(read)).rejects.toBe(startup);
  expect(read).not.toHaveBeenCalled();
  await broken.dispose().catch(() => {});
});
