import { expectTypeOf, test } from "vite-plus/test";
import {
  createCoordinatedStorage,
  createSyncClient,
  type AtomicLocalChangeStore,
  type CoordinatedStorage,
  type StorageRole,
} from "../../src";
import { checkpointStorage, collections, db, store, type DB, type QueryBuilder } from "./fixtures";

interface Handle {
  readonly kind: "handle";
}
type Request = { sql: string };
type Response = { rows: unknown[] };

declare const handle: Handle;
declare function adapterFor(database: Handle): DB;

test("exclusive storage infers the adapter and threads request/response types", () => {
  const storage = createCoordinatedStorage({
    open: () => ({
      database: handle,
      execute: async (request) => {
        expectTypeOf(request).toEqualTypeOf<Request>();
        return { rows: [] };
      },
    }),
    connect: (send: (request: Request) => Promise<Response>) => {
      expectTypeOf(send).returns.resolves.toEqualTypeOf<Response>();
      return handle;
    },
    createDBAdapter: adapterFor,
    createLocalChangeStore: () => store,
  });
  expectTypeOf(storage).toEqualTypeOf<CoordinatedStorage<DB, AtomicLocalChangeStore>>();
  expectTypeOf(storage.role).toEqualTypeOf<StorageRole>();
  expectTypeOf(storage.ready).toEqualTypeOf<Promise<void>>();

  const client = createSyncClient({ collections, storage, checkpointStorage });
  client.liveQuery({
    query: (qb) => {
      expectTypeOf(qb).toEqualTypeOf<QueryBuilder>();
      return 1;
    },
    onData: () => {},
  });
});

test("exclusive storage needs a connector and an owner executor", () => {
  // @ts-expect-error followers cannot reach the owner without connect
  createCoordinatedStorage({
    open: () => ({ database: handle, execute: async () => ({}) }),
    createDBAdapter: adapterFor,
    createLocalChangeStore: () => store,
  });
  // @ts-expect-error the owner must execute follower requests
  createCoordinatedStorage({
    open: () => ({ database: handle }),
    connect: () => handle,
    createDBAdapter: adapterFor,
    createLocalChangeStore: () => store,
  });
});

test("shared storage needs no connector and rejects one", () => {
  const storage = createCoordinatedStorage({
    sharing: "shared",
    coordinationKey: "todos",
    open: async () => ({ database: handle, close: async () => {} }),
    createDBAdapter: adapterFor,
    createLocalChangeStore: () => store,
  });
  expectTypeOf(storage).toEqualTypeOf<CoordinatedStorage<DB, AtomicLocalChangeStore>>();
  // @ts-expect-error shared databases are opened in every context, so no connector
  createCoordinatedStorage({
    sharing: "shared",
    open: () => ({ database: handle }),
    connect: () => handle,
    createDBAdapter: adapterFor,
    createLocalChangeStore: () => store,
  });
  createCoordinatedStorage({
    sharing: "shared",
    open: () => ({ database: handle }),
    createDBAdapter: () => db,
    // @ts-expect-error local-change stores must support atomic local mutations
    createLocalChangeStore: () => ({ ...store, atomicLocalMutationCapability: undefined }),
  });
});
