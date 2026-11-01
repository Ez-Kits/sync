import { afterEach, expect, test, vi } from "vite-plus/test";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { Component, createElement, StrictMode, useState, type ReactNode } from "react";
import { createScopedSyncClientReact, createSyncClientReact } from "../src/index";
import { createScopedClients } from "../src/scoped-clients";
import { createLocalDBStorage } from "@ez-kits/sync-client-core";

const todoCollection = { name: "todos", adapterConfig: {}, primaryField: "id" };
function createDB() {
  const db = {
    dbStorage: createLocalDBStorage({
      dialect: "sqlite",
      open: () => ({ exec: async () => ({ rows: [] }), close: async () => {} }),
    }),
    localChangeStore: {
      atomicLocalMutationCapability: "atomic" as const,
      initialize: vi.fn(async () => {}),
      appendEvents: vi.fn(async () => {}),
      hasAppliedEvent: vi.fn(async () => false),
      getPendingEvents: vi.fn(async () => []),
      deleteEvents: vi.fn(async () => {}),
      upsertDirtyRecord: vi.fn(async () => {}),
      removeDirtyRecords: vi.fn(async () => {}),
      getDirtyRecords: vi.fn(async () => []),
      getCheckpoint: vi.fn(async () => undefined),
      saveCheckpoint: vi.fn(async () => {}),
      getSkippedRemoteEvents: vi.fn(async () => []),
      upsertSkippedRemoteEvent: vi.fn(async () => {}),
      removeSkippedRemoteEvents: vi.fn(async () => {}),
    },
    queryBuilder: {},
    querySchema: { todos: {} },
    insert: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    get: vi.fn(async () => undefined),
    getMany: vi.fn(async () => []),
    transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(db)),
    commitLocalMutation: vi.fn(async ({ mutate, persistOutboxEvent, persistDirtyRecord }: any) => {
      const context = { operations: db, native: db };
      await mutate(context);
      await persistOutboxEvent(context);
      await persistDirtyRecord(context);
    }),
  };
  return db;
}

function setup() {
  const db = createDB();
  const client = createSyncClientReact({
    collections: [todoCollection],
    dbAdapter: db,
  } as never);
  return { client, db };
}

afterEach(() => cleanup());

test("provider exposes its sync client and the hook rejects use outside the provider", () => {
  const { client } = setup();
  expect(() => renderHook(() => client.useSyncClient())).toThrow(
    "useSyncClient must be used within",
  );
  function Child() {
    const value = client.useSyncClient();
    return createElement("output", null, value === client.syncClient ? "provided" : "wrong");
  }
  render(createElement(client.SyncClientProvider, null, createElement(Child)));
  expect(screen.getByText("provided")).toBeTruthy();
});

test("live query reports pending and data and unsubscribes on unmount", async () => {
  const { client } = setup();
  let release!: (value: string[]) => void;
  const query = vi.fn(
    () =>
      new Promise<string[]>((resolve) => {
        release = resolve;
      }),
  );
  const original = client.syncClient.liveQuery;
  const cleanupSpy = vi.fn();
  vi.spyOn(client.syncClient, "liveQuery").mockImplementation(((options: any) => {
    const unsubscribe = original(options);
    return () => {
      cleanupSpy();
      unsubscribe();
    };
  }) as never);
  function View() {
    const result = client.useLiveQuery({ collections: ["todos"], query });
    return createElement(
      "output",
      null,
      `${result.isPending}:${result.data?.join(",") ?? "empty"}`,
    );
  }
  const view = render(createElement(client.SyncClientProvider, null, createElement(View)));
  await waitFor(() => expect(screen.getByText("true:empty")).toBeTruthy());
  await act(async () => {
    release(["one", "two"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() => expect(screen.getByText("false:one,two")).toBeTruthy());
  view.unmount();
  expect(cleanupSpy).toHaveBeenCalledOnce();
});

test("live query stores query errors and reruns when deps change", async () => {
  const { client } = setup();
  const badQuery = vi.fn<() => Promise<string>>(async () => {
    throw new Error("query failed");
  });
  const { result, rerender } = renderHook(
    ({ query }: { query: () => Promise<string> }) =>
      client.useLiveQuery({ query, deps: [query] } as never),
    { wrapper: client.SyncClientProvider, initialProps: { query: badQuery } },
  );
  await waitFor(() => expect(result.current.error?.message).toBe("query failed"));
  const goodQuery = vi.fn(async () => "ok");
  rerender({ query: goodQuery });
  await waitFor(() => expect(result.current.data).toBe("ok"));
  expect(goodQuery).toHaveBeenCalled();
});

test("live query converts non-Error rejections", async () => {
  const { client } = setup();
  const { result } = renderHook(
    () => client.useLiveQuery({ query: async () => Promise.reject("string failure") } as never),
    { wrapper: client.SyncClientProvider },
  );
  await waitFor(() => expect(result.current.error?.message).toBe("string failure"));
});

test("live query is pending until its first result", () => {
  const { client } = setup();
  const { result } = renderHook(() => client.useLiveQuery({ query: async () => "ok" } as never), {
    wrapper: client.SyncClientProvider,
  });
  expect(result.current).toMatchObject({ data: undefined, isPending: true });
});

test("a new query function keeps the live query and runs on the next rerun", async () => {
  const { client } = setup();
  const liveQuery = vi.spyOn(client.syncClient, "liveQuery");
  let label = "first";
  const { result, rerender } = renderHook(
    () => client.useLiveQuery({ collections: ["todos"], query: async () => label } as never),
    { wrapper: client.SyncClientProvider },
  );
  await waitFor(() => expect(result.current.data).toBe("first"));
  label = "second";
  rerender();
  rerender();
  expect(liveQuery).toHaveBeenCalledOnce();
  await act(async () => {
    await client.syncClient.collections.todos.insert({ id: 1 } as never);
  });
  await waitFor(() => expect(result.current.data).toBe("second"));
  expect(liveQuery).toHaveBeenCalledOnce();
});

test("results of a replaced live query are ignored", async () => {
  const { client } = setup();
  let releaseOld!: (value: string) => void;
  const oldQuery = () =>
    new Promise<string>((resolve) => {
      releaseOld = resolve;
    });
  const { result, rerender } = renderHook(
    ({ query }: { query: () => Promise<string> }) =>
      client.useLiveQuery({ query, deps: [query] } as never),
    { wrapper: client.SyncClientProvider, initialProps: { query: oldQuery } },
  );
  await waitFor(() => expect(releaseOld).toBeDefined());
  rerender({ query: async () => "new" });
  await waitFor(() => expect(result.current.data).toBe("new"));
  await act(async () => {
    releaseOld("old");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(result.current.data).toBe("new");
});

function setupScoped(createDBFor: (scope: string) => ReturnType<typeof createDB> = createDB) {
  const dbs = new Map<string, ReturnType<typeof createDB>[]>();
  const createConfig = vi.fn((scope: string) => {
    const db = createDBFor(scope);
    dbs.set(scope, [...(dbs.get(scope) ?? []), db]);
    return { collections: [todoCollection], dbAdapter: db } as never;
  });
  const react = createScopedSyncClientReact({ createConfig });
  /** Holds state made on mount, so a remount shows a new value. */
  function Scope() {
    react.useSyncClient();
    const [id] = useState(() => Math.random().toString(36).slice(2));
    return createElement("output", null, id);
  }
  /** Numbers each client the first time it renders, so tests can tell clients apart. */
  const clientIds = new WeakMap<object, number>();
  let nextClientId = 0;
  function ClientId() {
    const client = react.useSyncClient();
    if (!clientIds.has(client)) clientIds.set(client, ++nextClientId);
    return createElement("output", null, `client-${clientIds.get(client)}`);
  }
  const provide = (scope: string, children: ReactNode, fallback?: ReactNode) =>
    createElement(react.SyncClientProvider, { scope, fallback, children });
  return { react, createConfig, dbs, Scope, ClientId, provide };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("scoped provider shows the fallback until the scope's database is ready", async () => {
  let open!: () => void;
  const { ClientId, provide } = setupScoped(() => {
    const db = createDB();
    const ready = new Promise<void>((resolve) => {
      open = resolve;
    });
    Object.defineProperty(db.dbStorage, "ready", { value: ready });
    return db;
  });
  render(provide("alice", createElement(ClientId), createElement("p", null, "opening")));
  expect(screen.getByText("opening")).toBeTruthy();
  await waitFor(() => expect(open).toBeDefined());
  await act(async () => {
    open();
    await tick();
  });
  expect(screen.getByText("client-1")).toBeTruthy();
});

test("switching scope disposes the previous client and remounts children", async () => {
  const { createConfig, dbs, Scope, ClientId, provide } = setupScoped();
  const view = render(provide("alice", createElement(Scope)));
  await waitFor(() => expect(createConfig).toHaveBeenCalledWith("alice"));
  const first = (await waitFor(() => view.container.querySelector("output")))!.textContent;
  const aliceClose = vi.spyOn(dbs.get("alice")![0]!.dbStorage, "close");

  view.rerender(provide("bob", createElement(Scope)));
  await waitFor(() => expect(createConfig).toHaveBeenCalledWith("bob"));
  await waitFor(() => expect(view.container.querySelector("output")).toBeTruthy());
  // A remount: component state of the previous scope is gone.
  expect(view.container.querySelector("output")!.textContent).not.toBe(first);
  await waitFor(() => expect(aliceClose).toHaveBeenCalledOnce());

  view.rerender(provide("bob", createElement(ClientId)));
  expect(createConfig).toHaveBeenCalledTimes(2);
});

test("StrictMode remounts reuse one client per scope", async () => {
  const { createConfig, dbs, ClientId, provide } = setupScoped();
  render(createElement(StrictMode, null, provide("alice", createElement(ClientId))));
  await waitFor(() => expect(screen.getByText("client-1")).toBeTruthy());
  await act(tick);
  expect(createConfig).toHaveBeenCalledOnce();
  const close = vi.spyOn(dbs.get("alice")![0]!.dbStorage, "close");
  await act(tick);
  expect(close).not.toHaveBeenCalled();
});

test("reopening a scope waits until its previous client has closed", async () => {
  let finishClose!: () => void;
  const order: string[] = [];
  const { createConfig, dbs, ClientId, provide } = setupScoped();
  const view = render(provide("alice", createElement(ClientId)));
  await waitFor(() => expect(screen.getByText("client-1")).toBeTruthy());
  vi.spyOn(dbs.get("alice")![0]!.dbStorage, "close").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        order.push("close started");
        finishClose = () => {
          order.push("close finished");
          resolve();
        };
      }),
  );
  createConfig.mockImplementation(((scope: string) => {
    order.push(`open ${scope}`);
    const db = createDB();
    dbs.set(scope, [...(dbs.get(scope) ?? []), db]);
    return { collections: [todoCollection], dbAdapter: db } as never;
  }) as never);

  view.rerender(provide("bob", createElement(ClientId)));
  await waitFor(() => expect(order).toContain("close started"));
  view.rerender(provide("alice", createElement(ClientId)));
  await act(tick);
  expect(order).not.toContain("open alice");
  await act(async () => {
    finishClose();
    await tick();
  });
  expect(order).toEqual(["open bob", "close started", "close finished", "open alice"]);
  await waitFor(() => expect(screen.getByText("client-3")).toBeTruthy());
});

test("a scope whose database cannot open throws to the error boundary", async () => {
  const { ClientId, provide } = setupScoped(() => {
    const db = createDB();
    const ready = Promise.reject(new Error("cannot open"));
    ready.catch(() => undefined);
    Object.defineProperty(db.dbStorage, "ready", { value: ready });
    return db;
  });
  class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
    override state: { error?: Error } = {};
    static getDerivedStateFromError(error: Error) {
      return { error };
    }
    override render() {
      return this.state.error
        ? createElement("p", null, this.state.error.message)
        : this.props.children;
    }
  }
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(createElement(Boundary, null, provide("alice", createElement(ClientId))));
  await waitFor(() => expect(screen.getByText("cannot open")).toBeTruthy());
});

test("a live query that first runs after unmount leaves no state behind", async () => {
  const { client } = setup();
  let reject!: (error: Error) => void;
  const query = vi.fn(
    () =>
      new Promise<string>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const view = renderHook(() => client.useLiveQuery({ query } as never), {
    wrapper: client.SyncClientProvider,
  });
  // The client runs the query once it is initialized, after the component is gone.
  view.unmount();
  await waitFor(() => expect(query).toHaveBeenCalledOnce());
  await act(async () => {
    reject(new Error("late"));
    await tick();
  });
  expect(view.result.current).toMatchObject({ data: undefined, error: undefined });
});

test("live query restarts only when deps change by length or value", async () => {
  const { client } = setup();
  const liveQuery = vi.spyOn(client.syncClient, "liveQuery");
  const { rerender } = renderHook(
    ({ deps }: { deps?: unknown[] }) =>
      client.useLiveQuery({ query: async () => "ok", deps } as never),
    {
      wrapper: client.SyncClientProvider,
      initialProps: { deps: undefined } as { deps?: unknown[] },
    },
  );
  rerender({ deps: [1] });
  rerender({ deps: [1, 2] });
  rerender({ deps: [1, 2] });
  rerender({ deps: undefined });
  // Mount, then each change: none, [1], [1, 2] (same again: no restart), none.
  expect(liveQuery).toHaveBeenCalledTimes(4);
});

const scopedConfig = (db = createDB()) => ({
  config: { collections: [todoCollection], dbAdapter: db } as never,
  db,
});

test("providers of one scope share its client until the last one unmounts", async () => {
  const { createConfig, dbs, provide, ClientId } = setupScoped();
  const view = render(
    createElement(
      "div",
      null,
      provide("alice", createElement(ClientId)),
      provide("alice", createElement(ClientId)),
    ),
  );
  await waitFor(() => expect(screen.getAllByText("client-1")).toHaveLength(2));
  expect(createConfig).toHaveBeenCalledOnce();
  const close = vi.spyOn(dbs.get("alice")![0]!.dbStorage, "close");
  view.rerender(createElement("div", null, provide("alice", createElement(ClientId))));
  await act(tick);
  expect(close).not.toHaveBeenCalled();
  view.unmount();
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});

test("a scope error that arrives after switching scope is ignored", async () => {
  let fail!: (error: Error) => void;
  const { provide, ClientId } = setupScoped((scope) => {
    const db = createDB();
    if (scope === "alice") {
      const ready = new Promise<void>((_resolve, reject) => {
        fail = reject;
      });
      ready.catch(() => undefined);
      Object.defineProperty(db.dbStorage, "ready", { value: ready });
    }
    return db;
  });
  const view = render(provide("alice", createElement(ClientId)));
  await waitFor(() => expect(fail).toBeDefined());
  view.rerender(provide("bob", createElement(ClientId)));
  await waitFor(() => expect(screen.getByText("client-1")).toBeTruthy());
  await act(async () => {
    fail(new Error("alice cannot open"));
    await tick();
  });
  expect(screen.getByText("client-1")).toBeTruthy();
});

test("releasing a lease twice releases it once", async () => {
  const { config, db } = scopedConfig();
  const clients = createScopedClients({ createConfig: () => config });
  const first = clients.acquire("alice");
  const second = clients.acquire("alice");
  await first.client;
  const close = vi.spyOn(db.dbStorage, "close");
  first.release();
  first.release();
  await tick();
  expect(close).not.toHaveBeenCalled();
  second.release();
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});

test("a scope reopens after its client failed to open or to close", async () => {
  const failing = createDB();
  Object.defineProperty(failing.dbStorage, "ready", { value: Promise.reject(new Error("no")) });
  failing.dbStorage.ready.catch(() => undefined);
  // Its cleanup fails too; the open error is the one reported.
  vi.spyOn(failing.dbStorage, "close").mockRejectedValue(new Error("cleanup failed"));
  const closingFails = createDB();
  vi.spyOn(closingFails.dbStorage, "close").mockRejectedValue(new Error("close failed"));
  const queue = [failing, closingFails, createDB()];
  const createConfig = vi.fn(() => scopedConfig(queue.shift()).config);
  const clients = createScopedClients({ createConfig });

  const notOpened = clients.acquire("alice");
  await expect(notOpened.client).rejects.toThrow("no");
  notOpened.release();
  await tick();

  const notClosed = clients.acquire("alice");
  await notClosed.client;
  notClosed.release();
  await tick();

  const reopened = clients.acquire("alice");
  await expect(reopened.client).resolves.toBeDefined();
  expect(createConfig).toHaveBeenCalledTimes(3);
});

test("a scope closed twice in a row is reopened only after both closes", async () => {
  const closes: Array<() => void> = [];
  const createConfig = vi.fn(() => {
    const db = createDB();
    vi.spyOn(db.dbStorage, "close").mockImplementation(
      () => new Promise<void>((resolve) => closes.push(resolve)),
    );
    return scopedConfig(db).config;
  });
  const clients = createScopedClients({ createConfig });

  const first = clients.acquire("alice");
  await first.client;
  first.release();
  await waitFor(() => expect(closes).toHaveLength(1));

  // Leased and released while the first close runs: its own close waits for its open.
  const second = clients.acquire("alice");
  second.release();
  await tick();
  closes[0]!();
  await waitFor(() => expect(closes).toHaveLength(2));

  // The first close ended; the second one has not: a new lease must still wait.
  const third = clients.acquire("alice");
  await tick();
  expect(createConfig).toHaveBeenCalledTimes(2);
  closes[1]!();
  await third.client;
  expect(createConfig).toHaveBeenCalledTimes(3);
});

test("usePendingWrites is pending until the outbox is read, then follows it", async () => {
  const { client, db } = setup();
  const outbox: Array<{ id: string; collection: string }> = [];
  db.localChangeStore.getPendingEvents.mockImplementation(async () => outbox as never);
  const { result } = renderHook(() => client.usePendingWrites(), {
    wrapper: client.SyncClientProvider,
  });
  expect(result.current).toEqual({ total: 0, rejected: 0, byCollection: {}, isPending: true });
  await waitFor(() => expect(result.current.isPending).toBe(false));

  outbox.push({ id: "e1", collection: "todos" });
  await act(async () => {
    await client.syncClient.collections.todos.insert({ id: "t1" } as never);
  });
  await waitFor(() =>
    expect(result.current).toEqual({
      total: 1,
      rejected: 0,
      byCollection: { todos: 1 },
      isPending: false,
    }),
  );
});
