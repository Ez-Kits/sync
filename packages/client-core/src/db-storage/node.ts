import {
  CoordinationUnavailableError,
  DBStorageClosedError,
  deserializeError,
  LeaderChangedError,
  LeaderUnavailableError,
  serializeError,
} from "./errors";
import {
  clientChannelName,
  clientLockName,
  controlChannelName,
  leaderChannelName,
  leaderLockName,
  type BroadcastChannelConstructor,
  type ControlMessage,
  type LeaderRequest,
  type LeaderResponse,
  type NodeOptions,
  type NodeRequestBody,
} from "./protocol";
import { TxScheduler } from "./tx-scheduler";
import type { DBEngine, DBRole } from "./types";

export type LockManagerLike = {
  request<T>(
    name: string,
    options: { mode: "exclusive"; signal?: AbortSignal },
    callback: (lock: unknown) => T | PromiseLike<T>,
  ): Promise<T>;
};

export interface NodeHost {
  locks?: LockManagerLike;
  BroadcastChannel?: BroadcastChannelConstructor;
}

export interface NodeEvents {
  role(role: DBRole): void;
  invalidate(): void;
  error(error: unknown): void;
}

interface Leadership {
  epoch: string;
  scheduler: TxScheduler;
  closing: boolean;
  requests: BroadcastChannel;
  replyChannels: Map<string, BroadcastChannel>;
  /** Per transaction id: lock requests that fire when the remote owner dies. */
  watchers: Map<string, AbortController>;
}

interface PendingRequest {
  body: NodeRequestBody;
  /** Epoch of the leader the request was sent to. */
  sentTo: string | undefined;
  /** `leaderSignals` when the timer was armed; unchanged at expiry means nobody answered. */
  signalsAtArm: number;
  probed: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function randomId(): string {
  return crypto.randomUUID();
}

/** Reads outside a transaction can be re-sent to a new leader; nothing else can. */
function isReplayable(body: NodeRequestBody): boolean {
  return body.t === "exec" && body.txId === undefined && body.query.method !== "run";
}

function transactionId(body: NodeRequestBody): string | undefined {
  return body.t === "begin" ? undefined : body.txId;
}

/** Stop waiting for an engine when leadership ends; close it if it opens later. */
function openUnlessAborted(
  open: (signal: AbortSignal) => Promise<DBEngine>,
  signal: AbortSignal,
): Promise<DBEngine> {
  const opening = open(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason);
      void opening.then((engine) => engine.close()).catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    opening.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Transaction ids are `<leader epoch>/<id>`: a transaction never outlives its leader. */
function splitTransactionId(txId: string): [epoch: string, id: string] {
  const index = txId.lastIndexOf("/");
  return [txId.slice(0, index), txId.slice(index + 1)];
}

/**
 * One context's view of a shared database. Contexts elect a leader with Web Locks; the
 * leader opens the engine and serves every context, followers forward their statements
 * and transactions to it over BroadcastChannel. Runs in a storage worker.
 */
export class DBStorageNode {
  private readonly key: string;
  private readonly clientId: string;
  private readonly locks: LockManagerLike | undefined;
  private readonly Channel: BroadcastChannelConstructor | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private control: BroadcastChannel | undefined;
  private replies: BroadcastChannel | undefined;
  private leaderEpoch: string | undefined;
  private leaderChannel: BroadcastChannel | undefined;
  private leadership: Leadership | undefined;
  private role: DBRole | undefined;
  private lockController: AbortController | undefined;
  private lockReleased: Promise<void> = Promise.resolve();
  private readonly lifetime = new AbortController();
  private leaderSignals = 0;
  private nextId = 0;
  private closed = false;

  constructor(
    private readonly options: NodeOptions & {
      open(signal: AbortSignal): Promise<DBEngine>;
      host: NodeHost;
      events: NodeEvents;
    },
  ) {
    this.key = options.key;
    this.clientId = options.clientId;
    this.locks = options.host.locks;
    this.Channel = options.host.BroadcastChannel;
    this.start();
  }

  request(body: NodeRequestBody): Promise<unknown> {
    if (this.closed) return Promise.reject(new DBStorageClosedError());
    const leadership = this.leadership;
    if (leadership && !leadership.closing) {
      return this.executeLeading(leadership, body, this.clientId);
    }
    return this.forward(body);
  }

  /** Step down (page hidden or frozen); other contexts may take over. */
  release(): void {
    this.lockController?.abort();
    // A quick rejoin must be able to queue again before the old request settles.
    this.lockController = undefined;
  }

  /** Compete for leadership again after `release`. */
  rejoin(): void {
    if (this.closed) return;
    this.requestLeadership();
    this.post({ t: "who-is-leader" });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lockController?.abort();
    await this.lockReleased;
    for (const [id, pending] of this.pending) this.reject(id, pending, new DBStorageClosedError());
    this.leaderChannel?.close();
    this.replies?.close();
    this.control?.close();
    this.lifetime.abort();
  }

  private start(): void {
    const { locks, Channel } = this;
    if (!locks || !Channel) {
      this.options.events.error(new CoordinationUnavailableError());
      return;
    }
    this.control = new Channel(controlChannelName(this.key));
    this.control.onmessage = (message: MessageEvent) =>
      this.handleControl(message.data as ControlMessage);
    this.replies = new Channel(clientChannelName(this.key, this.clientId));
    this.replies.onmessage = (message: MessageEvent) =>
      this.handleResponse(message.data as LeaderResponse);
    // Held until this context goes away, so the leader can roll back its transactions.
    void locks
      .request(
        clientLockName(this.key, this.clientId),
        { mode: "exclusive", signal: this.lifetime.signal },
        () =>
          new Promise<void>((resolve) =>
            this.lifetime.signal.addEventListener("abort", () => resolve(), { once: true }),
          ),
      )
      .catch(() => undefined);
    this.requestLeadership();
    this.post({ t: "who-is-leader" });
  }

  private post(message: ControlMessage): void {
    this.control?.postMessage(message);
  }

  private setRole(role: DBRole): void {
    if (this.role === role) return;
    this.role = role;
    this.options.events.role(role);
  }

  private requestLeadership(): void {
    if (this.lockController) return;
    const controller = new AbortController();
    this.lockController = controller;
    this.lockReleased = this.locks!.request(
      leaderLockName(this.key),
      { mode: "exclusive", signal: controller.signal },
      async () => {
        let engine: DBEngine;
        try {
          engine = await openUnlessAborted(
            (signal) => this.options.open(signal),
            controller.signal,
          );
        } catch (error) {
          // A context that cannot open the database lets the next one try.
          if (!controller.signal.aborted) this.options.events.error(error);
          return;
        }
        this.lead(engine);
        if (!controller.signal.aborted) {
          await new Promise<void>((resolve) =>
            controller.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        await this.stepDown();
      },
    )
      .catch((error: unknown) => {
        if (!controller.signal.aborted) this.options.events.error(error);
      })
      .finally(() => {
        if (this.lockController === controller) this.lockController = undefined;
      });
  }

  private lead(engine: DBEngine): void {
    const epoch = randomId();
    const requests = new this.Channel!(leaderChannelName(this.key, epoch));
    const leadership: Leadership = {
      epoch,
      scheduler: new TxScheduler(engine, {
        transactionTimeoutMs: this.options.transactionTimeoutMs,
      }),
      closing: false,
      requests,
      replyChannels: new Map(),
      watchers: new Map(),
    };
    requests.onmessage = (message: MessageEvent) =>
      void this.handleRequest(leadership, message.data as LeaderRequest);
    this.leadership = leadership;
    this.leaderChannel?.close();
    this.leaderChannel = undefined;
    const hadLeader = this.leaderEpoch !== undefined;
    this.leaderEpoch = undefined;

    // Requests waiting for a leader now run here.
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (pending.sentTo !== undefined && !isReplayable(pending.body)) {
        pending.reject(new LeaderChangedError());
        continue;
      }
      this.executeLeading(leadership, pending.body, this.clientId).then(
        (value) => pending.resolve(value),
        (error: unknown) => pending.reject(error),
      );
    }
    this.setRole("leader");
    if (hadLeader) this.options.events.invalidate();
    this.post({ t: "leader-hello", epoch });
  }

  private async stepDown(): Promise<void> {
    const leadership = this.leadership!;
    leadership.closing = true;
    this.post({ t: "leader-bye", epoch: leadership.epoch });
    try {
      await leadership.scheduler.close();
    } finally {
      leadership.requests.close();
      for (const channel of leadership.replyChannels.values()) channel.close();
      for (const watcher of leadership.watchers.values()) watcher.abort();
      this.leadership = undefined;
      if (!this.closed) {
        this.setRole("follower");
        this.post({ t: "who-is-leader" });
      }
    }
  }

  private async executeLeading(
    leadership: Leadership,
    body: NodeRequestBody,
    from: string,
  ): Promise<unknown> {
    try {
      return await this.executeOnScheduler(leadership, body, from);
    } catch (error) {
      // Work cut short by stepping down can be retried on the next leader.
      throw leadership.closing ? new LeaderChangedError() : error;
    }
  }

  private async executeOnScheduler(
    leadership: Leadership,
    body: NodeRequestBody,
    from: string,
  ): Promise<unknown> {
    const { scheduler } = leadership;
    if (body.t === "begin") {
      const id = await scheduler.begin(from);
      if (from !== this.clientId) this.watchOwner(leadership, from, id);
      return `${leadership.epoch}/${id}`;
    }
    const txId = transactionId(body);
    let localId: string | undefined;
    if (txId !== undefined) {
      const [epoch, id] = splitTransactionId(txId);
      if (epoch !== leadership.epoch) throw new LeaderChangedError();
      localId = id;
    }
    if (body.t === "exec") return scheduler.exec(body.query, localId, from);
    try {
      if (body.t === "commit") await scheduler.commit(localId!);
      else await scheduler.rollback(localId!);
    } finally {
      leadership.watchers.get(localId!)?.abort();
      leadership.watchers.delete(localId!);
    }
  }

  /** Roll back `owner`'s transaction if its context dies before finishing it. */
  private watchOwner(leadership: Leadership, owner: string, txId: string): void {
    const controller = new AbortController();
    leadership.watchers.set(txId, controller);
    void this.locks!.request(
      clientLockName(this.key, owner),
      { mode: "exclusive", signal: controller.signal },
      async () => {
        leadership.watchers.delete(txId);
        await leadership.scheduler.abandon(owner);
      },
    ).catch(() => undefined);
  }

  private async handleRequest(leadership: Leadership, request: LeaderRequest): Promise<void> {
    const { id, from, ...body } = request;
    const reply = (response: LeaderResponse) => this.reply(leadership, from, response);
    if (leadership.closing) {
      reply({
        t: "err",
        id,
        error: serializeError(new LeaderChangedError()),
        retriable: true,
      });
      return;
    }
    try {
      const result = await this.executeLeading(leadership, body as NodeRequestBody, from);
      reply({ t: "ok", id, result });
    } catch (error) {
      reply({ t: "err", id, error: serializeError(error), retriable: false });
    }
  }

  private reply(leadership: Leadership, clientId: string, response: LeaderResponse): void {
    let channel = leadership.replyChannels.get(clientId);
    if (!channel) {
      channel = new this.Channel!(clientChannelName(this.key, clientId));
      leadership.replyChannels.set(clientId, channel);
    }
    try {
      channel.postMessage(response);
    } catch {
      // Stepped down meanwhile: the follower re-routes on `leader-bye`.
    }
  }

  private handleControl(message: ControlMessage): void {
    switch (message?.t) {
      case "who-is-leader":
        if (this.leadership && !this.leadership.closing) {
          this.post({ t: "leader-hello", epoch: this.leadership.epoch });
        }
        return;
      case "leader-hello":
        if (!this.leadership) this.setLeader(message.epoch);
        return;
      case "leader-bye":
        this.clearLeader(message.epoch);
        return;
    }
  }

  private setLeader(epoch: string): void {
    this.leaderSignals += 1;
    if (this.leaderEpoch === epoch) return;
    const changed = this.leaderEpoch !== undefined || this.role !== undefined;
    this.leaderChannel?.close();
    this.leaderEpoch = epoch;
    this.leaderChannel = new this.Channel!(leaderChannelName(this.key, epoch));
    for (const [id, pending] of this.pending) {
      if (pending.sentTo === undefined || isReplayable(pending.body)) this.send(id, pending);
      else this.reject(id, pending, new LeaderChangedError());
    }
    this.setRole("follower");
    if (changed) this.options.events.invalidate();
  }

  private clearLeader(epoch: string): void {
    if (this.leaderEpoch !== epoch) return;
    this.leaderChannel?.close();
    this.leaderChannel = undefined;
    this.leaderEpoch = undefined;
    // Everything pending was sent to this leader.
    for (const [id, pending] of this.pending) {
      if (isReplayable(pending.body)) pending.sentTo = undefined;
      else this.reject(id, pending, new LeaderChangedError());
    }
  }

  private forward(body: NodeRequestBody): Promise<unknown> {
    const txId = transactionId(body);
    if (txId !== undefined && splitTransactionId(txId)[0] !== this.leaderEpoch) {
      return Promise.reject(new LeaderChangedError());
    }
    return new Promise((resolve, reject) => {
      const id = `${this.clientId}:${++this.nextId}`;
      const pending: PendingRequest = {
        body,
        sentTo: undefined,
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
    const channel = this.leaderChannel;
    if (!channel) return;
    pending.sentTo = this.leaderEpoch;
    channel.postMessage({ ...pending.body, id, from: this.clientId } satisfies LeaderRequest);
  }

  /**
   * On expiry, probe for the leader. A live but busy leader answers, so the request keeps
   * waiting; it fails only when a probe goes unanswered.
   */
  private armTimer(id: string, pending: PendingRequest): void {
    pending.signalsAtArm = this.leaderSignals;
    pending.timer = setTimeout(() => {
      if (pending.probed && this.leaderSignals === pending.signalsAtArm) {
        this.reject(id, pending, new LeaderUnavailableError());
        return;
      }
      pending.probed = true;
      this.post({ t: "who-is-leader" });
      this.armTimer(id, pending);
    }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  }

  private reject(id: string, pending: PendingRequest, error: unknown): void {
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(error);
  }

  private handleResponse(response: LeaderResponse): void {
    const pending = this.pending.get(response?.id);
    if (!pending) return;
    if (response.t === "ok") {
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      pending.resolve(response.result);
      return;
    }
    const error = deserializeError(response.error);
    // The leader is stepping down: re-send reads to the next one, fail everything else.
    if (response.retriable && isReplayable(pending.body)) {
      pending.sentTo = undefined;
      return;
    }
    this.reject(response.id, pending, error);
  }
}
