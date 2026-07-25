import type { ChangeBusEvent, ChangeBusEventDataMap, ChangeBusListener } from "./types";

export class ChangeBusStreamChannel<C extends ChangeBusEventDataMap> {
  private listeners = new Set<ChangeBusListener<C>>();
  private pendingEvents: Set<ChangeBusEvent<C>> = new Set();
  private pending = false;

  publish<N extends keyof C>(event: ChangeBusEvent<C, N>): void {
    this.pendingEvents.add(event);
    this.queueEmitEvents();
  }

  publishBatch(events: ChangeBusEvent<C>[]): void {
    for (const event of events) {
      this.pendingEvents.add(event);
    }
    this.queueEmitEvents();
  }

  subscribe(listener: ChangeBusListener<C>): () => void {
    this.listeners.add(listener);
    return () => this.unsubscribe(listener);
  }

  unsubscribe(listener: ChangeBusListener<C>): void {
    this.listeners.delete(listener);
  }

  private queueEmitEvents(): void {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      const events = Array.from(this.pendingEvents);
      this.pendingEvents.clear();
      this.pending = false;
      for (const listener of this.listeners) {
        listener(events);
      }
    });
  }
}
