import { ChangeBusStreamChannel } from "./change-bus-stream-channel";
import type {
  ChangeBusEvent,
  ChangeBusEventDataMap,
  ChangeBusListener,
  ChangeBusStream,
  ChangeBusSubscribeOptions,
} from "./types";

export class ChangeBus<C extends ChangeBusEventDataMap> {
  private local = new ChangeBusStreamChannel<C>();
  private remote = new ChangeBusStreamChannel<C>();

  publishLocal<N extends keyof C>(event: ChangeBusEvent<C, N>): void {
    this.local.publish(event);
  }

  publishRemote<N extends keyof C>(event: ChangeBusEvent<C, N>): void {
    this.remote.publish(event);
  }

  publishLocalBatch(events: ChangeBusEvent<C>[]): void {
    this.local.publishBatch(events);
  }

  publishRemoteBatch(events: ChangeBusEvent<C>[]): void {
    this.remote.publishBatch(events);
  }

  subscribe(listener: ChangeBusListener<C>, options?: ChangeBusSubscribeOptions): () => void;
  subscribe<N extends keyof C>(
    collection: N,
    listener: ChangeBusListener<C, N>,
    options?: ChangeBusSubscribeOptions,
  ): () => void;
  subscribe<N extends keyof C>(
    collections: readonly N[],
    listener: ChangeBusListener<C, N>,
    options?: ChangeBusSubscribeOptions,
  ): () => void;
  subscribe<N extends keyof C>(
    arg1: ChangeBusListener<C> | N | readonly N[],
    arg2?: ChangeBusListener<C, N> | ChangeBusSubscribeOptions,
    arg3?: ChangeBusSubscribeOptions,
  ): () => void {
    if (typeof arg1 === "function") {
      return this.subscribeToStreams(
        arg1,
        this.getSubscribeStreams(arg2 as ChangeBusSubscribeOptions | undefined),
      );
    }

    if (typeof arg2 !== "function") {
      throw new TypeError(
        "subscribe: expected (listener[, options]), (collection, listener[, options]), or (collections, listener[, options])",
      );
    }

    const selectedCollections = new Set((Array.isArray(arg1) ? arg1 : [arg1]).map(String));
    const scopedListener: ChangeBusListener<C> = (events) => {
      const filteredEvents = events.filter((event) =>
        selectedCollections.has(String(event.collection)),
      );
      if (filteredEvents.length === 0) return;
      arg2(filteredEvents as ChangeBusEvent<C, N>[]);
    };

    return this.subscribeToStreams(scopedListener, this.getSubscribeStreams(arg3));
  }

  private unsubscribe(listener: ChangeBusListener<C>): void {
    this.local.unsubscribe(listener);
    this.remote.unsubscribe(listener);
  }

  private subscribeToStreams(
    listener: ChangeBusListener<C>,
    streams: readonly ChangeBusStream[],
  ): () => void {
    for (const stream of streams) {
      if (stream === "local") {
        this.local.subscribe(listener);
      } else {
        this.remote.subscribe(listener);
      }
    }
    return () => this.unsubscribe(listener);
  }

  private getSubscribeStreams(options?: ChangeBusSubscribeOptions): readonly ChangeBusStream[] {
    const stream = options?.stream ?? "both";
    if (stream === "both") return ["local", "remote"] as const;
    return [stream] as const;
  }
}
