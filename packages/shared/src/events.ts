/**
 * Typed in-process event bus. Publishers don't know who listens; the SSE layer, the
 * dashboard rollups and tests all subscribe here. A Postgres LISTEN/NOTIFY implementation
 * can replace this when the Core splits into several processes.
 */
export interface EventEnvelope<TTopic extends string = string, TPayload = unknown> {
  seq: number;
  ts: number;
  topic: TTopic;
  payload: TPayload;
}

export type EventMap = Record<string, unknown>;

export interface EventBus<E extends EventMap> {
  publish<K extends keyof E & string>(topic: K, payload: E[K]): EventEnvelope<K, E[K]>;
  subscribe<K extends keyof E & string>(topic: K | '*', handler: (event: EventEnvelope<K, E[K]>) => void): () => void;
}

export class InMemoryEventBus<E extends EventMap> implements EventBus<E> {
  private seq = 0;
  private readonly handlers = new Map<string, Set<(event: EventEnvelope<string, unknown>) => void>>();
  private readonly now: () => number;
  private readonly onHandlerError: (error: unknown, topic: string) => void;

  constructor(options: { now?: () => number; onHandlerError?: (error: unknown, topic: string) => void } = {}) {
    this.now = options.now ?? Date.now;
    this.onHandlerError = options.onHandlerError ?? (() => {});
  }

  publish<K extends keyof E & string>(topic: K, payload: E[K]): EventEnvelope<K, E[K]> {
    const event: EventEnvelope<K, E[K]> = { seq: ++this.seq, ts: this.now(), topic, payload };
    for (const key of [topic, '*']) {
      for (const handler of this.handlers.get(key) ?? []) {
        // A failing subscriber must never break the publisher (e.g. the agent loop).
        try {
          handler(event as EventEnvelope<string, unknown>);
        } catch (error) {
          this.onHandlerError(error, topic);
        }
      }
    }
    return event;
  }

  subscribe<K extends keyof E & string>(topic: K | '*', handler: (event: EventEnvelope<K, E[K]>) => void): () => void {
    const set = this.handlers.get(topic) ?? new Set();
    const h = handler as (event: EventEnvelope<string, unknown>) => void;
    set.add(h);
    this.handlers.set(topic, set);
    return () => set.delete(h);
  }
}
