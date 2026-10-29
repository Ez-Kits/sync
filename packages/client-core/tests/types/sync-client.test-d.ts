import { expectTypeOf, test } from "vite-plus/test";
import {
  createSyncClient,
  isPermanentPushError,
  PushRejectedError,
  type ChangeBusEvent,
  type ChangeBusEventDataMapFromCollectionConfigMap,
  type DBRole,
  type SyncClient,
  type SyncStatusEvent,
} from "../../src";
import {
  checkpointStorage,
  collections,
  db,
  type Checkpoint,
  type Collections,
  type DB,
  type QueryBuilder,
  type QuerySchema,
  type TodoInsert,
  type TodoSelect,
} from "./fixtures";

type DataMap = ChangeBusEventDataMapFromCollectionConfigMap<Collections>;

const client = createSyncClient({ collections, dbAdapter: db, checkpointStorage });

test("createSyncClient infers collections, adapter and checkpoint", () => {
  expectTypeOf(client).toEqualTypeOf<SyncClient<Collections, DB, Checkpoint>>();
  expectTypeOf(client.collections.todos.insert).parameter(0).toEqualTypeOf<TodoInsert>();
  expectTypeOf(client.collections.todos.get(1)).resolves.toEqualTypeOf<TodoSelect>();
  expectTypeOf(client.getCheckpoint("todos")).resolves.toEqualTypeOf<Checkpoint | undefined>();
  expectTypeOf(client.subscribeStatus).parameter(0).parameter(0).toEqualTypeOf<SyncStatusEvent>();
});

test("collection runtimes reject mismatched payloads", async () => {
  // @ts-expect-error unknown collections are not exposed
  void client.collections.projects;
  // @ts-expect-error todos are keyed by numeric id
  await client.collections.todos.delete("1");
  // @ts-expect-error checkpoints only accept known collection names
  await client.getCheckpoint("projects");
});

test("subscribe overloads narrow events", () => {
  client.subscribe((events) => {
    expectTypeOf(events).toEqualTypeOf<ChangeBusEvent<DataMap>[]>();
  });
  client.subscribe("todos", (events) => {
    expectTypeOf(events).toEqualTypeOf<ChangeBusEvent<DataMap, "todos">[]>();
  });
  client.subscribe(["todos", "users"], (events) => {
    expectTypeOf(events).toEqualTypeOf<ChangeBusEvent<DataMap, "todos" | "users">[]>();
  });
  // @ts-expect-error unknown collection names are rejected
  client.subscribe("projects", () => {});
  // @ts-expect-error stream must be local, remote, or both
  client.subscribe(() => {}, { stream: "server" });
});

test("liveQuery passes the adapter query builder and infers results", () => {
  client.liveQuery({
    collections: ["todos"],
    query: (qb, schema) => {
      expectTypeOf(qb).toEqualTypeOf<QueryBuilder>();
      expectTypeOf(schema).toEqualTypeOf<QuerySchema>();
      return 3;
    },
    onData: (data) => expectTypeOf(data).toEqualTypeOf<number>(),
  });
  client.liveQuery({
    // @ts-expect-error live queries only watch known collections
    collections: ["projects"],
    query: () => 1,
    onData: () => {},
  });
});

test("clients take a DB adapter and expose the storage role", () => {
  createSyncClient({
    collections,
    // @ts-expect-error clients take the adapter, not the raw storage
    dbAdapter: { queryBuilder: 1 },
    checkpointStorage,
  });
  createSyncClient({
    collections,
    dbAdapter: db,
    checkpointStorage,
    // @ts-expect-error tab coordination is configured on the DB storage
    coordinationKey: "todos",
  });
  expectTypeOf(client.role).toEqualTypeOf<DBRole>();
  expectTypeOf(client.subscribeRole).parameter(0).parameter(0).toEqualTypeOf<DBRole>();
  expectTypeOf(client.dispose).returns.toEqualTypeOf<Promise<void>>();
});

test("push rejections carry the typed event", () => {
  createSyncClient({
    collections,
    dbAdapter: db,
    checkpointStorage,
    onPushRejected: ({ event, error, discard }) => {
      expectTypeOf(event).toEqualTypeOf<ChangeBusEvent<DataMap>>();
      expectTypeOf(error).toBeUnknown();
      expectTypeOf(discard).toEqualTypeOf<() => Promise<void>>();
    },
  });
  expectTypeOf(client.retryRejectedPushes).toEqualTypeOf<() => void>();
  expectTypeOf(isPermanentPushError).parameter(0).toBeUnknown();
  expectTypeOf<PushRejectedError>().toHaveProperty("permanent");
  expectTypeOf<PushRejectedError>().toExtend<Error>();
});
