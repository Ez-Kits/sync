import { createSyncClient } from "@ez-kits/sync-client-core";
import { expect, test, vi } from "vite-plus/test";
import { clientConfig, collection, makeDb } from "../../../client-core/tests/helpers/storage.ts";
import { createDurableObjectSyncAdapter } from "../../src/client.ts";
import { FakeServer } from "./fake-server.ts";

function device(server: FakeServer) {
  const db = makeDb();
  const syncAdapter = createDurableObjectSyncAdapter({
    url: "https://app.test/api/sync",
    collections: [collection],
    getToken: () => "t1",
    fetch: server.fetch,
    WebSocket: server.WebSocket,
  });
  const client = createSyncClient(clientConfig(db, { syncAdapter }));
  return { db, client, rows: () => Object.fromEntries(db.rows) };
}

const serverRows = (server: FakeServer) =>
  Object.fromEntries(
    [...server.records]
      .filter(([, record]) => !record.deleted)
      .map(([key, record]) => [(JSON.parse(key) as string[])[1], record.data]),
  );

test("two clients converge through the server after offline writes on both", async () => {
  const server = new FakeServer();
  const a = device(server);
  const b = device(server);
  a.client.startSync();
  b.client.startSync();

  await a.client.collections.todos.insert({ id: "1", title: "first" } as never);
  await a.client.collections.todos.insert({ id: "gone", title: "x" } as never);
  await vi.waitFor(() => expect(b.rows()).toEqual(a.rows()));
  expect(b.rows()["1"]).toEqual({ id: "1", title: "first" });

  // Both go offline and write, the same record included.
  a.client.stopSync();
  b.client.stopSync();
  await a.client.collections.todos.update({ id: "1", title: "from a" } as never);
  await a.client.collections.todos.delete("gone" as never);
  await b.client.collections.todos.update({ id: "1", done: true } as never);
  await b.client.collections.todos.insert({ id: "2", title: "from b" } as never);

  a.client.startSync();
  await a.client.waitForPushed();
  b.client.startSync();
  await b.client.waitForPushed();
  await vi.waitFor(() => {
    expect(a.rows()).toEqual(serverRows(server));
    expect(b.rows()).toEqual(serverRows(server));
  });
  // B's update conflicted with A's; its pending write was replayed over A's row.
  expect(serverRows(server)).toEqual({
    "1": { id: "1", title: "from a", done: true },
    "2": { id: "2", title: "from b" },
  });

  await a.client.dispose();
  await b.client.dispose();
});
