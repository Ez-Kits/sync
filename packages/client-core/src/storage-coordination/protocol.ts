import type { ChangeBusEvent } from "../change-bus";
import type { LocalMutation } from "../collection/local-mutation";

export type BroadcastChannelConstructor = new (name: string) => BroadcastChannel;

/** Messages on the shared `ez-sync:<key>` channel. */
export type ControlMessage =
  | { t: "owner-hello"; epoch: string }
  | { t: "owner-bye"; epoch: string }
  | { t: "who-is-owner" }
  | {
      t: "changes";
      /** Context that posted the message; `seq` increases by one per sender. */
      sender: string;
      seq: number;
      /** Context whose write produced the events (it already published them locally). */
      origin: string;
      source: "local" | "pull";
      events: ChangeBusEvent<any>[];
    };

export type OwnerRequestBody =
  | { t: "mutate"; mutation: LocalMutation }
  | { t: "query"; request: unknown };

export type OwnerRequest = OwnerRequestBody & {
  id: string;
  from: string;
  epoch: string;
  attempt: number;
};

export type OwnerResponse =
  | { t: "ok"; id: string; result?: unknown }
  | { t: "err"; id: string; message: string; retriable: boolean };

export const controlChannelName = (key: string) => `ez-sync:${key}`;
export const ownerChannelName = (key: string, epoch: string) => `ez-sync:${key}:owner:${epoch}`;
export const tabChannelName = (key: string, tabId: string) => `ez-sync:${key}:tab:${tabId}`;
