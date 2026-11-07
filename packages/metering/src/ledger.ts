import { type Clock, type NanoUsd, type PriorityClass, systemClock, uuidv7 } from '@feroxes/shared';
import { type PriceBook, type TokenUsage, computeCost } from './pricing.ts';

export type UsageOutcome = 'ok' | 'error' | 'cancelled';

export interface UsageEventInput {
  providerId: string;
  modelId: string;
  route: string;
  taskType: string;
  priority: PriorityClass;
  attempt: number;
  outcome: UsageOutcome;
  errorClass?: string;
  usage: TokenUsage;
  latencyMs?: number;
  ttftMs?: number;
  runId?: string;
  sessionId?: string;
  jobId?: string;
  promptVersion?: string;
  estimatedInputTokens?: number;
  estimatedCost?: NanoUsd;
}

export interface UsageEvent extends UsageEventInput {
  id: string;
  ts: number;
  priceId?: string;
  cost: NanoUsd;
  /** True when no price was valid at call time. The dashboard surfaces these. */
  unpriced: boolean;
}

export interface UsageFilter {
  from?: number;
  to?: number;
  providerId?: string;
  modelId?: string;
  route?: string;
  priority?: PriorityClass;
  runId?: string;
}

/** Append-only ledger of every metered call, including failed attempts. */
export interface UsageLedgerStore {
  append(event: UsageEvent): Promise<void>;
  query(filter: UsageFilter): Promise<UsageEvent[]>;
}

export class InMemoryUsageLedgerStore implements UsageLedgerStore {
  readonly events: UsageEvent[] = [];

  async append(event: UsageEvent): Promise<void> {
    this.events.push(Object.freeze({ ...event }));
  }

  async query(f: UsageFilter): Promise<UsageEvent[]> {
    return this.events.filter(
      (e) =>
        (f.from === undefined || e.ts >= f.from) &&
        (f.to === undefined || e.ts < f.to) &&
        (f.providerId === undefined || e.providerId === f.providerId) &&
        (f.modelId === undefined || e.modelId === f.modelId) &&
        (f.route === undefined || e.route === f.route) &&
        (f.priority === undefined || e.priority === f.priority) &&
        (f.runId === undefined || e.runId === f.runId),
    );
  }
}

export class UsageLedger {
  private readonly store: UsageLedgerStore;
  private readonly prices: PriceBook;
  private readonly clock: Clock;

  constructor(deps: { store: UsageLedgerStore; prices: PriceBook; clock?: Clock }) {
    this.store = deps.store;
    this.prices = deps.prices;
    this.clock = deps.clock ?? systemClock;
  }

  /** Prices the call with the price valid now and appends it. */
  async record(input: UsageEventInput): Promise<UsageEvent> {
    const ts = this.clock.now();
    const price = this.prices.priceAt(input.modelId, ts);
    const event: UsageEvent = {
      ...input,
      id: uuidv7(ts),
      ts,
      cost: price ? computeCost(price, input.usage).total : 0,
      unpriced: !price,
      ...(price ? { priceId: price.id } : {}),
    };
    await this.store.append(event);
    return event;
  }

  query(filter: UsageFilter): Promise<UsageEvent[]> {
    return this.store.query(filter);
  }

  async summarize(filter: UsageFilter, groupBy: 'providerId' | 'modelId' | 'route' | 'priority') {
    const rows = new Map<string, { key: string; calls: number; errors: number; cost: NanoUsd; inputTokens: number; outputTokens: number; cachedInputTokens: number }>();
    for (const e of await this.store.query(filter)) {
      const key = String(e[groupBy]);
      const row = rows.get(key) ?? { key, calls: 0, errors: 0, cost: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      row.calls++;
      if (e.outcome !== 'ok') row.errors++;
      row.cost += e.cost;
      row.inputTokens += e.usage.inputTokens;
      row.outputTokens += e.usage.outputTokens;
      row.cachedInputTokens += e.usage.cachedInputTokens ?? 0;
      rows.set(key, row);
    }
    return [...rows.values()].sort((a, b) => b.cost - a.cost);
  }
}
