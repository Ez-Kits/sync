import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vite-plus/test";
import * as server from "../src/server.ts";

test("the object migrates the app schema and the library tables", async () => {
  const stub = env.TEST_SYNC.getByName("migrations");
  const tables = await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name",
      )
      .toArray()
      .map((row) => row.name),
  );
  expect(tables).toEqual(
    expect.arrayContaining([
      "ez_sync_meta",
      "ez_sync_records",
      "ez_sync_records_seq",
      "items",
      "lists",
    ]),
  );
  expect(tables).not.toContain("ez_sync_applied_events");
});

test("the server entry point shares the protocol constants", () => {
  expect(server).toMatchObject({
    SUBPROTOCOL: "ezsync",
    CLOSE_UNAUTHENTICATED: 4001,
    CLOSE_SCOPE_DELETED: 4410,
  });
});
