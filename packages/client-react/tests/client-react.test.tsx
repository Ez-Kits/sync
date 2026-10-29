import { afterEach, expect, test, vi } from "vite-plus/test";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { createSyncClientReact } from "../src/index";
import { createLocalDBStorage } from "@ez-kits/sync-client-core";

const todoCollection = { name: "todos", adapterConfig: {}, primaryField: "id" };
function setup() {
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

test("live query stores query errors and reruns when query inputs change", async () => {
  const { client } = setup();
  const badQuery = vi.fn<() => Promise<string>>(async () => {
    throw new Error("query failed");
  });
  const { result, rerender } = renderHook(
    ({ query }: { query: () => Promise<string> }) => client.useLiveQuery({ query } as never),
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
