import type { LocalMutation } from "../collection/local-mutation";
import { StorageOwnerUnavailableError } from "./errors";
import type { OwnerRequestBody, OwnerResponse } from "./protocol";
import { ownerChannelName, tabChannelName, type BroadcastChannelConstructor } from "./protocol";

/** Runs a request in this context once it has become the owner. */
export type LocalExecutor = (body: OwnerRequestBody, attempt: number) => Promise<unknown>;

interface PendingRequest {
  body: OwnerRequestBody;
  attempt: number;
  /** `ownerSignals` when the timer was armed; unchanged at expiry means nobody answered. */
  signalsAtArm: number;
  probed: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/**
 * Sends follower reads and writes to the current owner. Requests survive owner changes:
 * they are re-sent to each new owner (writes with a higher attempt number so the owner
 * can execute them idempotently), or run locally when this context is promoted.
 */
export class FollowerClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly replies: BroadcastChannel;
  private ownerEpoch: string | undefined;
  private ownerChannel: BroadcastChannel | undefined;
  private local: LocalExecutor | undefined;
  private nextId = 0;
  /** Counts owner announcements, including repeats answering a probe. */
  private ownerSignals = 0;

  constructor(
    private readonly deps: {
      BroadcastChannel: BroadcastChannelConstructor;
      key: string;
      tabId: string;
      timeoutMs: number;
      probeOwner: () => void;
    },
  ) {
    this.replies = new deps.BroadcastChannel(tabChannelName(deps.key, deps.tabId));
    this.replies.onmessage = (message: MessageEvent) =>
      this.handleResponse(message.data as OwnerResponse);
  }

  mutate(mutation: LocalMutation): Promise<void> {
    return this.request({ t: "mutate", mutation }) as Promise<void>;
  }

  query(request: unknown): Promise<unknown> {
    return this.request({ t: "query", request });
  }

  /** A new owner announced itself. Returns whether the owner changed. */
  setOwner(epoch: string): boolean {
    this.ownerSignals += 1;
    if (this.ownerEpoch === epoch) return false;
    this.ownerChannel?.close();
    this.ownerEpoch = epoch;
    this.ownerChannel = new this.deps.BroadcastChannel(ownerChannelName(this.deps.key, epoch));
    for (const [id, pending] of this.pending) this.send(id, pending);
    return true;
  }

  /** The owner of `epoch` went away; hold requests until the next owner appears. */
  clearOwner(epoch: string): void {
    if (this.ownerEpoch !== epoch) return;
    this.ownerChannel?.close();
    this.ownerChannel = undefined;
    this.ownerEpoch = undefined;
  }

  /** This context became the owner: run pending and future requests in place. */
  takeover(execute: LocalExecutor): void {
    this.local = execute;
    for (const [id, pending] of this.pending) {
      this.settle(id, pending, () => execute(pending.body, pending.attempt + 1));
    }
  }

  /** This context stopped owning the storage; route requests to the next owner again. */
  release(): void {
    this.local = undefined;
  }

  dispose(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new StorageOwnerUnavailableError());
    }
    this.ownerChannel?.close();
    this.replies.close();
  }

  private request(body: OwnerRequestBody): Promise<unknown> {
    const local = this.local;
    if (local) return local(body, 1);
    return new Promise((resolve, reject) => {
      const id = `${this.deps.tabId}:${++this.nextId}`;
      const pending: PendingRequest = {
        body,
        attempt: 0,
        signalsAtArm: 0,
        probed: false,
        timer: undefined,
        resolve,
        reject,
      };
      this.pending.set(id, pending);
      this.armTimer(id, pending);
      this.send(id, pending);
    });
  }

  private send(id: string, pending: PendingRequest): void {
    const channel = this.ownerChannel;
    if (!channel) return;
    pending.attempt += 1;
    channel.postMessage({
      ...pending.body,
      id,
      from: this.deps.tabId,
      epoch: this.ownerEpoch,
      attempt: pending.attempt,
    });
  }

  /**
   * On expiry, probe for the owner and re-send. A live but slow owner answers the probe,
   * so the request keeps waiting; it fails only when a probe goes unanswered.
   */
  private armTimer(id: string, pending: PendingRequest): void {
    pending.signalsAtArm = this.ownerSignals;
    pending.timer = setTimeout(() => {
      if (pending.probed && this.ownerSignals === pending.signalsAtArm) {
        this.pending.delete(id);
        pending.reject(new StorageOwnerUnavailableError());
        return;
      }
      pending.probed = true;
      this.deps.probeOwner();
      this.send(id, pending);
      this.armTimer(id, pending);
    }, this.deps.timeoutMs);
  }

  private settle(id: string, pending: PendingRequest, run: () => Promise<unknown>): void {
    clearTimeout(pending.timer);
    this.pending.delete(id);
    run().then(
      (value) => pending.resolve(value),
      (error: unknown) => pending.reject(error),
    );
  }

  private handleResponse(response: OwnerResponse): void {
    const pending = this.pending.get(response?.id);
    if (!pending) return;
    if (response.t === "ok") {
      this.settle(response.id, pending, async () => response.result);
      return;
    }
    // The owner is shutting down: keep waiting for the next one to announce itself.
    if (response.retriable) return;
    this.settle(response.id, pending, async () => {
      throw new Error(response.message);
    });
  }
}
