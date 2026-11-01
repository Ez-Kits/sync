import type { ChangeBusEvent } from "../change-bus";
import type { BroadcastChannelConstructor } from "../db-storage/protocol";

/** Events committed by another context. */
export interface ChangeNotice {
  events: ChangeBusEvent<any>[];
  /** `local`: written through a collection; `pull`: applied by the leader's sync. */
  source: "local" | "pull";
}

export interface SyncTabListener {
  changes?(notice: ChangeNotice): void;
  /** Notifications may have been missed: re-read everything. */
  invalidate?(): void;
  /** A follower wants sync running; only the leader acts on it. */
  syncRequest?(): void;
  /** The leader's parked (rejected) outbox event ids, sent whenever its outbox changed. */
  outbox?(parked: string[]): void;
  /** Another context wants the leader's `outbox` message; only the leader acts on it. */
  outboxRequest?(): void;
}

type SyncTabMessage =
  | {
      t: "changes";
      /** Context that committed the events; `seq` increases by one per sender. */
      sender: string;
      seq: number;
      source: "local" | "pull";
      events: ChangeBusEvent<any>[];
    }
  | { t: "sync-request" }
  | { t: "outbox"; parked: string[] }
  | { t: "outbox-request" };

export const syncChannelName = (key: string) => `ez-sync:${key}:sync`;

/**
 * Sync-level messages between the contexts of one storage: committed changes (so every
 * context's live queries and the leader's outbox push stay current) and sync requests.
 */
export class SyncTabChannel {
  /** Unset once closed: a late message, e.g. of an initialization that ends after `close`, is dropped. */
  private channel: BroadcastChannel | undefined;
  private readonly listeners = new Set<SyncTabListener>();
  private readonly lastSeq = new Map<string, number>();
  private sendSeq = 0;

  constructor(
    key: string,
    private readonly tabId: string = crypto.randomUUID(),
    Channel: BroadcastChannelConstructor | undefined = (
      globalThis as { BroadcastChannel?: BroadcastChannelConstructor }
    ).BroadcastChannel,
  ) {
    if (!Channel) return;
    this.channel = new Channel(syncChannelName(key));
    this.channel.onmessage = (message: MessageEvent) => this.handle(message.data as SyncTabMessage);
  }

  subscribe(listener: SyncTabListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  broadcastChanges(events: ChangeBusEvent<any>[], source: "local" | "pull"): void {
    if (events.length === 0) return;
    this.channel?.postMessage({
      t: "changes",
      sender: this.tabId,
      seq: ++this.sendSeq,
      source,
      events,
    } satisfies SyncTabMessage);
  }

  requestSync(): void {
    this.channel?.postMessage({ t: "sync-request" } satisfies SyncTabMessage);
  }

  broadcastOutbox(parked: string[]): void {
    this.channel?.postMessage({ t: "outbox", parked } satisfies SyncTabMessage);
  }

  requestOutbox(): void {
    this.channel?.postMessage({ t: "outbox-request" } satisfies SyncTabMessage);
  }

  /** Forget sequence numbers, e.g. after the leader changed and everything was re-read. */
  reset(): void {
    this.lastSeq.clear();
  }

  close(): void {
    this.listeners.clear();
    this.channel?.close();
    this.channel = undefined;
  }

  private handle(message: SyncTabMessage): void {
    if (message?.t === "sync-request") {
      for (const listener of this.listeners) listener.syncRequest?.();
      return;
    }
    if (message?.t === "outbox") {
      for (const listener of this.listeners) listener.outbox?.(message.parked);
      return;
    }
    if (message?.t === "outbox-request") {
      for (const listener of this.listeners) listener.outboxRequest?.();
      return;
    }
    if (message?.t !== "changes") return;
    const last = this.lastSeq.get(message.sender);
    this.lastSeq.set(message.sender, message.seq);
    if (last !== undefined && message.seq !== last + 1) {
      for (const listener of this.listeners) listener.invalidate?.();
    }
    for (const listener of this.listeners) {
      listener.changes?.({ events: message.events, source: message.source });
    }
  }
}
