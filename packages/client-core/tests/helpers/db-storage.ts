import { vi } from "vite-plus/test";
import { DBStorageNode, type NodeEvents } from "../../src/db-storage/node";
import { clientLockName, leaderLockName } from "../../src/db-storage/protocol";
import type { DBEngine, DBQuery, DBRole } from "../../src/db-storage";
import { FakeBroadcastChannel, type FakeLockManager } from "./tabs";

/** The persisted "disk" engines reopen; survives leader handoffs. */
export function createDisk() {
  return { rows: new Map<string, string>() };
}

export const q = (sql: string, method: DBQuery["method"] = "run"): DBQuery => ({
  sql,
  params: [],
  method,
});

/**
 * A tiny key-value engine with transactional snapshots. Statements:
 * `SET k v`, `GET`, `FAIL`, `WAIT ms`, and BEGIN/COMMIT/ROLLBACK.
 */
export function memoryEngine(disk = createDisk()) {
  let snapshot: Map<string, string> | undefined;
  const log: string[] = [];
  const engine = {
    log,
    disk,
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    exec: vi.fn(async (query: DBQuery) => {
      log.push(query.sql);
      const [command = "", ...args] = query.sql.split(" ");
      switch (command.toUpperCase()) {
        case "BEGIN":
          if (snapshot) throw new Error("cannot start a transaction within a transaction");
          snapshot = new Map(disk.rows);
          return { rows: [] };
        case "COMMIT":
          snapshot = undefined;
          return { rows: [] };
        case "ROLLBACK":
          if (snapshot) disk.rows = snapshot;
          snapshot = undefined;
          return { rows: [] };
        case "SET":
          disk.rows.set(args[0]!, args[1]!);
          return { rows: [] };
        case "GET":
          return {
            rows: [...disk.rows].map(([k, v]) => (query.rowMode === "object" ? { k, v } : [k, v])),
          };
        case "WAIT":
          await new Promise((resolve) => setTimeout(resolve, Number(args[0])));
          return { rows: [] };
        default:
          throw new Error(`statement failed: ${query.sql}`);
      }
    }),
  } satisfies DBEngine & Record<string, unknown>;
  return engine;
}

export type MemoryEngine = ReturnType<typeof memoryEngine>;

/** One simulated tab's storage node, sharing locks, channels and the disk with the others. */
export function startNode(
  locks: FakeLockManager,
  tag: string,
  options: {
    disk?: ReturnType<typeof createDisk>;
    open?: (signal: AbortSignal) => Promise<DBEngine>;
    key?: string;
    requestTimeoutMs?: number;
    transactionTimeoutMs?: number;
    locksAvailable?: boolean;
  } = {},
) {
  class TabChannel extends FakeBroadcastChannel {
    constructor(name: string) {
      super(name);
      this.tag = tag;
    }
  }
  const engines: MemoryEngine[] = [];
  const roles: DBRole[] = [];
  const errors: unknown[] = [];
  const invalidate = vi.fn();
  const events: NodeEvents = {
    role: (role) => roles.push(role),
    invalidate,
    error: (error) => errors.push(error),
  };
  const disk = options.disk ?? createDisk();
  const key = options.key ?? "default";
  const node = new DBStorageNode({
    key,
    clientId: tag,
    requestTimeoutMs: options.requestTimeoutMs,
    transactionTimeoutMs: options.transactionTimeoutMs,
    open:
      options.open ??
      (async () => {
        const engine = memoryEngine(disk);
        engines.push(engine);
        return engine;
      }),
    host: {
      locks: options.locksAvailable === false ? undefined : (locks as never),
      BroadcastChannel: TabChannel as unknown as new (name: string) => BroadcastChannel,
    },
    events,
  });
  return {
    node,
    tag,
    engines,
    roles,
    errors,
    invalidate,
    get role() {
      return roles.at(-1);
    },
    /** Kill the tab: its channels go silent and its locks are freed. */
    crash() {
      for (const channel of FakeBroadcastChannel.instances) {
        if (channel.tag === tag) channel.close();
      }
      if (roles.at(-1) === "leader") locks.crash(leaderLockName(key));
      locks.crash(clientLockName(key, tag));
    },
  };
}
