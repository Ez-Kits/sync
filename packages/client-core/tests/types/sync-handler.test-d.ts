import { expectTypeOf, test } from "vite-plus/test";
import type {
  ChangeBusEvent,
  ChangeBusEventDataMapFromCollectionConfigMap,
  ConflictResolution,
  PullCheckpointMap,
  PullOptions,
  PushOptions,
  SyncAdapter,
  SyncHandler,
  SyncStatus,
} from "../../src";
import type { Checkpoint, Collections, DB, TodoSelect } from "./fixtures";

type DataMap = ChangeBusEventDataMapFromCollectionConfigMap<Collections>;
type Adapter = SyncAdapter<DataMap, "todos" | "users", Checkpoint>;

test("sync status is a closed union", () => {
  expectTypeOf<SyncStatus>().toEqualTypeOf<
    "stopped" | "starting" | "syncing" | "idle" | "offline" | "error"
  >();
});

test("pull options carry typed checkpoints and events", () => {
  expectTypeOf<Adapter["pull"]>()
    .parameter(0)
    .toEqualTypeOf<PullOptions<DataMap, "todos" | "users", Checkpoint>>();
  expectTypeOf<PullCheckpointMap<DataMap, "todos" | "users", Checkpoint>>().toEqualTypeOf<{
    todos?: Checkpoint;
    users?: Checkpoint;
  }>();
  type Commit = PullOptions<DataMap, "todos", Checkpoint>["commitChanges"];
  expectTypeOf<Commit>()
    .parameter(0)
    .toHaveProperty("changes")
    .toEqualTypeOf<ChangeBusEvent<DataMap, "todos">[]>();
});

test("push options carry typed events", () => {
  expectTypeOf<Adapter["push"]>()
    .parameter(0)
    .toEqualTypeOf<PushOptions<DataMap, "todos" | "users">>();
  expectTypeOf<PushOptions<DataMap, "users">["events"]>().toEqualTypeOf<
    ChangeBusEvent<DataMap, "users">[]
  >();
});

test("push acknowledgements are awaitable", () => {
  type Commit = PushOptions<DataMap, "todos">["commitChanges"];
  expectTypeOf<Commit>().returns.toEqualTypeOf<Promise<void>>();
  expectTypeOf<Commit>()
    .parameter(0)
    .toHaveProperty("events")
    .toEqualTypeOf<ChangeBusEvent<DataMap, "todos">[]>();
});

test("conflict resolution receives the typed local record", () => {
  type Context = Parameters<ConflictResolution<DataMap, "todos">>[0];
  expectTypeOf<Context["local"]>().toEqualTypeOf<TodoSelect | undefined>();
  expectTypeOf<Context["remote"]>().toEqualTypeOf<ChangeBusEvent<DataMap, "todos">>();

  const resolve: ConflictResolution<DataMap> = () => "local";
  expectTypeOf(resolve).returns.not.toBeAny();
  // @ts-expect-error decisions are limited to local, remote, or replacement data
  const invalid: ConflictResolution<DataMap> = () => "merge";
  void invalid;
});

test("outbox notifications accept known collection names", () => {
  type Notify = SyncHandler<Collections, DB, Checkpoint>["notifyOutboxChanged"];
  expectTypeOf<Notify>().parameter(0).toEqualTypeOf<readonly ("todos" | "users")[] | undefined>();
  const notify = {} as Notify;
  notify();
  notify(["todos"]);
  // @ts-expect-error unknown collections are rejected
  notify(["projects"]);
});
