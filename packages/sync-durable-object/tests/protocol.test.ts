import { expect, test } from "vite-plus/test";
import * as client from "../src/client.ts";

// The server entry needs workerd: `tests-workerd/sqlite.test.ts` checks its half.
test("the client entry point shares the protocol constants", () => {
  expect(client).toMatchObject({
    SUBPROTOCOL: "ezsync",
    CLOSE_UNAUTHENTICATED: 4001,
    CLOSE_SCOPE_DELETED: 4410,
  });
});
