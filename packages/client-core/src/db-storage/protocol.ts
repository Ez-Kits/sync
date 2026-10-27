import type { SerializedError } from "./errors";
import type { DBQuery, DBRole } from "./types";

export type BroadcastChannelConstructor = new (name: string) => BroadcastChannel;

/** A storage request, as sent by a context to its node and by a follower node to the leader. */
export type NodeRequestBody =
  | { t: "exec"; query: DBQuery; txId?: string }
  | { t: "begin" }
  | { t: "commit"; txId: string }
  | { t: "rollback"; txId: string };

/** Messages on the shared `ez-sync:db:<key>` channel. */
export type ControlMessage =
  | { t: "leader-hello"; epoch: string }
  | { t: "leader-bye"; epoch: string }
  | { t: "who-is-leader" };

/** Follower node → leader node, on the leader's channel. */
export type LeaderRequest = NodeRequestBody & { id: string; from: string };

/** Leader node → follower node, on the follower's channel. */
export type LeaderResponse =
  | { t: "ok"; id: string; result?: unknown }
  | { t: "err"; id: string; error: SerializedError; retriable: boolean };

export interface NodeOptions {
  key: string;
  clientId: string;
  /** Follower request timeout before the leader is probed again. */
  requestTimeoutMs?: number;
  /** Idle time after which the leader rolls an open transaction back. */
  transactionTimeoutMs?: number;
}

/** Main thread → its storage worker. */
export type PortRequest =
  | ({ t: "init"; engineOptions: unknown } & NodeOptions)
  | { t: "request"; id: number; body: NodeRequestBody }
  | { t: "release" }
  | { t: "rejoin" }
  | { t: "close"; id: number };

/** Storage worker → main thread. */
export type PortMessage =
  | { t: "role"; role: DBRole }
  | { t: "invalidate" }
  | { t: "error"; error: SerializedError }
  | { t: "response"; id: number; ok: true; result?: unknown }
  | { t: "response"; id: number; ok: false; error: SerializedError };

export const controlChannelName = (key: string) => `ez-sync:db:${key}`;
export const leaderLockName = (key: string) => `ez-sync:db:${key}:leader`;
export const leaderChannelName = (key: string, epoch: string) =>
  `ez-sync:db:${key}:leader:${epoch}`;
export const clientChannelName = (key: string, clientId: string) =>
  `ez-sync:db:${key}:client:${clientId}`;
/** Held by each context for its lifetime; the leader takes it to detect that context's death. */
export const clientLockName = clientChannelName;
