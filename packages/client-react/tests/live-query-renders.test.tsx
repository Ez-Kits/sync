import { afterEach, expect, test, vi } from "vite-plus/test";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { createElement, Profiler, StrictMode, type ReactNode } from "react";
import { createLocalDBStorage } from "@ez-kits/sync-client-core";
import { createSyncClientReact } from "../src/index";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const db: any = {
    dbStorage: createLocalDBStorage({
      dialect: "sqlite",
      open: () => ({ exec: async () => ({ rows: [] }), close: async () => {} }),
    }),
    localChangeStore: {
      atomicLocalMutationCapability: "atomic" as const,
      initialize: async () => {},
      appendEvents: async () => {},
      hasAppliedEvent: async () => false,
      getPendingEvents: async () => [],
      deleteEvents: async () => {},
      getCheckpoint: async () => undefined,
      saveCheckpoint: async () => {},
      getSkippedRemoteEvents: async () => [],
      upsertSkippedRemoteEvent: async () => {},
      removeSkippedRemoteEvents: async () => {},
    },
    queryBuilder: {},
    querySchema: { todos: {} },
    insert: async () => {},
    update: async () => {},
    delete: async () => {},
    get: async () => undefined,
    getMany: async () => [],
    transaction: async (fn: (tx: any) => Promise<unknown>) => fn(db),
    commitLocalMutation: async ({ mutate, persistOutboxEvent }: any) => {
      const context = { operations: db, native: db };
      await mutate(context);
      await persistOutboxEvent(context);
    },
  };
  const client = createSyncClientReact({
    collections: [{ name: "todos", adapterConfig: {}, primaryField: "id" }],
    dbAdapter: db,
  } as never);
  const write = () =>
    act(async () => {
      await client.syncClient.collections.todos.update({ id: 1 } as never);
      await tick();
    });
  return { client, write };
}

/** Renders the hook, recording each render's result and the number of commits. */
function track(client: any, useResult: () => any, wrap: (node: ReactNode) => ReactNode = (n) => n) {
  const results: any[] = [];
  const commits = { count: 0 };
  function View() {
    results.push(useResult());
    return null;
  }
  const view = render(
    wrap(
      createElement(
        client.SyncClientProvider,
        null,
        createElement(
          Profiler,
          { id: "view", onRender: () => void (commits.count += 1) },
          createElement(View),
        ),
      ),
    ),
  );
  return { results, commits, view };
}

afterEach(() => cleanup());

test("a write that leaves the query's result unchanged does not re-render", async () => {
  const { client, write } = setup();
  const rows = [
    { id: 1, visible: false, title: "excluded" },
    { id: 2, visible: true, title: "kept" },
  ];
  const query = vi.fn(async () => rows.filter((row) => row.visible).map((row) => ({ ...row })));
  const { results, commits } = track(client, () =>
    client.useLiveQuery({ collections: ["todos"], query } as never),
  );
  await act(tick);
  await waitFor(() => expect(results.at(-1)).toMatchObject({ isPending: false }));
  const renders = results.length;
  const committed = commits.count;
  const before = results.at(-1).data;

  rows[0]!.title = "changed, still excluded";
  await write();

  expect(query).toHaveBeenCalledTimes(2);
  expect(results.length - renders).toBe(0);
  expect(commits.count - committed).toBe(0);
  expect(results.at(-1).data).toBe(before);
});

test("a changed result is one commit, and isPending stays false across background re-runs", async () => {
  const { client, write } = setup();
  let value = 0;
  const { results, commits } = track(client, () =>
    client.useLiveQuery({ collections: ["todos"], query: async () => [value] } as never),
  );
  await act(tick);
  const settledAt = results.findIndex((result) => !result.isPending);
  expect(settledAt).toBeGreaterThan(0);
  const committed = commits.count;

  value = 1;
  await write();
  expect(results.at(-1).data).toEqual([1]);
  expect(commits.count - committed).toBe(1);
  expect(results.slice(settledAt).map((result) => result.isPending)).not.toContain(true);
});

test("outside act, as in the app, an unchanged write commits nothing and a changed one once", async () => {
  const { client } = setup();
  let value = 0;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // Takes a while, like a query in the database worker.
  const query = async () => {
    await wait(5);
    return [value];
  };
  const { results, commits } = track(client, () =>
    client.useLiveQuery({ collections: ["todos"], query } as never),
  );
  await act(() => wait(30));
  const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = false;
  const writeAndSettle = async () => {
    await client.syncClient.collections.todos.update({ id: 1 } as never);
    await wait(30);
  };
  try {
    const beforeUnchanged = commits.count;
    await writeAndSettle();
    const unchanged = commits.count - beforeUnchanged;
    value = 1;
    const beforeChanged = commits.count;
    await writeAndSettle();
    const changed = commits.count - beforeChanged;
    expect(results.at(-1).data).toEqual([1]);
    expect({ unchanged, changed }).toEqual({ unchanged: 0, changed: 1 });
  } finally {
    environment.IS_REACT_ACT_ENVIRONMENT = true;
  }
});

test("the first result arrives in a single commit with isPending", async () => {
  const { client } = setup();
  const { results, commits } = track(client, () =>
    client.useLiveQuery({ query: async () => "rows" } as never),
  );
  expect(commits.count).toBe(1);
  await act(tick);
  expect(commits.count).toBe(2);
  expect(results.at(-1)).toEqual({ data: "rows", isPending: false, error: undefined });
});

test("a failed re-run keeps the last good data and sets error", async () => {
  const { client, write } = setup();
  const query = vi.fn<() => Promise<string[]>>().mockResolvedValue(["good"]);
  const { results, commits } = track(client, () =>
    client.useLiveQuery({ collections: ["todos"], query } as never),
  );
  await act(tick);
  const settledAt = results.findIndex((result) => !result.isPending);
  const committed = commits.count;

  query.mockRejectedValueOnce(new Error("passing failure"));
  await write();
  expect(results.at(-1)).toMatchObject({ data: ["good"], isPending: false });
  expect(results.at(-1).error?.message).toBe("passing failure");
  expect(commits.count - committed).toBe(1);
  // Never blanked while it lasted.
  expect(results.slice(settledAt).map((result) => result.data)).not.toContain(undefined);
});

test("a successful run clears the error even when its result is unchanged", async () => {
  const { client, write } = setup();
  const query = vi.fn<() => Promise<string[]>>().mockResolvedValue(["good"]);
  const { results } = track(client, () =>
    client.useLiveQuery({ collections: ["todos"], query } as never),
  );
  await act(tick);
  query.mockRejectedValueOnce(new Error("passing failure"));
  await write();
  expect(results.at(-1).error).toBeDefined();

  await write();
  expect(results.at(-1)).toEqual({ data: ["good"], isPending: false, error: undefined });

  // Back to normal: unchanged results stop re-rendering again.
  const renders = results.length;
  await write();
  expect(results.length).toBe(renders);
});

test("a failed first run settles with the error and no data", async () => {
  const { client } = setup();
  const { result } = renderHook(
    () =>
      client.useLiveQuery({
        query: async () => {
          throw new Error("first failed");
        },
      } as never) as any,
    { wrapper: client.SyncClientProvider },
  );
  await act(tick);
  expect(result.current.data).toBeUndefined();
  expect(result.current.isPending).toBe(false);
  expect(result.current.error.message).toBe("first failed");
});

test("a deps change is pending at once, keeps the data and drops the old error", async () => {
  const { client } = setup();
  const answers = new Map<string, () => Promise<string>>([
    ["good", async () => "good data"],
    ["bad", async () => Promise.reject(new Error("bad"))],
    ["next", async () => "next data"],
  ]);
  const seen: { filter: string; result: any }[] = [];
  const { result, rerender } = renderHook(
    ({ filter }: { filter: string }) => {
      const value: any = client.useLiveQuery({
        query: () => answers.get(filter)!(),
        deps: [filter],
      } as never);
      seen.push({ filter, result: value });
      return value;
    },
    { wrapper: client.SyncClientProvider, initialProps: { filter: "good" } },
  );
  await act(tick);
  expect(result.current).toEqual({ data: "good data", isPending: false, error: undefined });

  // The render with the new deps is already pending; no later commit is needed for it.
  rerender({ filter: "bad" });
  expect(seen.find(({ filter }) => filter === "bad")!.result).toEqual({
    data: "good data",
    isPending: true,
    error: undefined,
  });
  await act(tick);
  expect(result.current.isPending).toBe(false);
  expect(result.current.data).toBe("good data");
  expect(result.current.error.message).toBe("bad");

  rerender({ filter: "next" });
  expect(seen.find(({ filter }) => filter === "next")!.result).toEqual({
    data: "good data",
    isPending: true,
    error: undefined,
  });
  await act(tick);
  expect(result.current).toEqual({ data: "next data", isPending: false, error: undefined });
});

test("the latest isEqual decides; none falls back to deep equality", async () => {
  const { client, write } = setup();
  let version = 0;
  const first = vi.fn((a: any, b: any) => a.id === b.id);
  const second = vi.fn(() => false);
  const { result, rerender } = renderHook(
    ({ isEqual }: { isEqual?: (a: any, b: any) => boolean }) =>
      client.useLiveQuery({
        collections: ["todos"],
        query: async () => ({ id: 1, version: (version += 1) }),
        isEqual,
      } as never) as any,
    {
      wrapper: client.SyncClientProvider,
      initialProps: { isEqual: first } as { isEqual?: (a: any, b: any) => boolean },
    },
  );
  await act(tick);
  await write();
  expect(first).toHaveBeenCalledOnce();
  expect(result.current.data.version).toBe(1);

  rerender({ isEqual: second });
  await write();
  expect(second).toHaveBeenCalledOnce();
  expect(result.current.data.version).toBe(3);

  rerender({ isEqual: undefined });
  await write();
  expect(result.current.data.version).toBe(4);
});

test("StrictMode's double subscribe settles on the live subscription", async () => {
  const { client, write } = setup();
  const liveQuery = vi.spyOn(client.syncClient, "liveQuery");
  let value = 0;
  const { results } = track(
    client,
    () => client.useLiveQuery({ collections: ["todos"], query: async () => [value] } as never),
    (node) => createElement(StrictMode, null, node),
  );
  await act(tick);
  expect(liveQuery).toHaveBeenCalledTimes(2);
  expect(results.at(-1)).toEqual({ data: [0], isPending: false, error: undefined });

  value = 1;
  await write();
  expect(results.at(-1)).toEqual({ data: [1], isPending: false, error: undefined });
});
