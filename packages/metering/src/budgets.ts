import {
  type Clock,
  type NanoUsd,
  type Period,
  type PowerMode,
  type PriorityClass,
  type SystemState,
  type Tier,
  MINUTE,
  Mutex,
  isBackground,
  localParts,
  nextPeriodStart,
  periodStart,
  systemClock,
  uuidv7,
} from '@feroxes/shared';

export type HardAction = 'downgrade' | 'defer' | 'ask' | 'block';

export type BudgetScope =
  | { type: 'global' }
  | { type: 'provider'; providerId: string }
  | { type: 'route'; route: string }
  | { type: 'priority'; priorities: PriorityClass[] };

export interface Budget {
  id: string;
  name: string;
  scope: BudgetScope;
  period: Period;
  limit: NanoUsd;
  /** Part of the limit that only interactive work may spend. */
  interactiveReserve?: NanoUsd;
  /** Percent thresholds that raise an alert once per period. */
  softThresholds: number[];
  onLimit: { interactive: HardAction; background: HardAction };
  enabled: boolean;
}

export interface ReserveRequest {
  requestId: string;
  estimate: NanoUsd;
  priority: PriorityClass;
  providerId: string;
  route: string;
}

export type ReserveResult =
  | { ok: true; reservationId: string; budgetIds: string[] }
  | { ok: false; action: HardAction; budgetId: string; budgetName: string; retryAt: number; spent: NanoUsd; reserved: NanoUsd; limit: NanoUsd };

export interface ReservationItem {
  budgetId: string;
  periodStart: number;
  amount: NanoUsd;
  effectiveLimit: NanoUsd;
}

export interface Counter {
  spent: NanoUsd;
  reserved: NanoUsd;
}

/**
 * Storage for budget counters and reservations. Every method is atomic.
 * Postgres: one transaction that locks the counter rows in budget-id order (Phase 1 plan §7.4).
 */
export interface BudgetStore {
  listBudgets(): Promise<Budget[]>;
  tryReserve(input: { reservationId: string; requestId: string; items: ReservationItem[]; expiresAt: number }):
    Promise<{ ok: true } | { ok: false; budgetId: string; counter: Counter }>;
  /** Moves a reservation's amounts from reserved to spent (with the actual cost). Returns new counters. */
  settle(reservationId: string, actual: NanoUsd): Promise<{ budgetId: string; periodStart: number; counter: Counter }[]>;
  release(reservationId: string): Promise<void>;
  expire(now: number): Promise<number>;
  counter(budgetId: string, periodStart: number): Promise<Counter>;
  /** Records that a threshold alert fired. Returns false if it already fired this period. */
  markAlert(budgetId: string, periodStart: number, threshold: number): Promise<boolean>;
}

interface StoredReservation {
  id: string;
  requestId: string;
  items: ReservationItem[];
  expiresAt: number;
  status: 'active' | 'settled' | 'released' | 'expired';
}

export class InMemoryBudgetStore implements BudgetStore {
  private readonly mutex = new Mutex();
  private readonly counters = new Map<string, Counter>();
  private readonly reservations = new Map<string, StoredReservation>();
  private readonly alerts = new Set<string>();
  budgets: Budget[];

  constructor(budgets: Budget[] = []) {
    this.budgets = budgets;
  }

  private key(budgetId: string, periodStart: number) {
    return `${budgetId}@${periodStart}`;
  }

  private get(budgetId: string, periodStart: number): Counter {
    const k = this.key(budgetId, periodStart);
    let c = this.counters.get(k);
    if (!c) {
      c = { spent: 0, reserved: 0 };
      this.counters.set(k, c);
    }
    return c;
  }

  async listBudgets() {
    return this.budgets.filter((b) => b.enabled);
  }

  tryReserve(input: { reservationId: string; requestId: string; items: ReservationItem[]; expiresAt: number }) {
    return this.mutex.run((): { ok: true } | { ok: false; budgetId: string; counter: Counter } => {
      const items = [...input.items].sort((a, b) => a.budgetId.localeCompare(b.budgetId));
      for (const item of items) {
        const c = this.get(item.budgetId, item.periodStart);
        if (c.spent + c.reserved + item.amount > item.effectiveLimit) {
          return { ok: false, budgetId: item.budgetId, counter: { ...c } };
        }
      }
      for (const item of items) this.get(item.budgetId, item.periodStart).reserved += item.amount;
      this.reservations.set(input.reservationId, { id: input.reservationId, requestId: input.requestId, items, expiresAt: input.expiresAt, status: 'active' });
      return { ok: true };
    });
  }

  settle(reservationId: string, actual: NanoUsd) {
    return this.mutex.run(() => {
      const r = this.reservations.get(reservationId);
      if (!r || r.status !== 'active') return [];
      r.status = 'settled';
      return r.items.map((item) => {
        const c = this.get(item.budgetId, item.periodStart);
        c.reserved = Math.max(0, c.reserved - item.amount);
        c.spent += actual;
        return { budgetId: item.budgetId, periodStart: item.periodStart, counter: { ...c } };
      });
    });
  }

  release(reservationId: string) {
    return this.mutex.run(() => {
      const r = this.reservations.get(reservationId);
      if (!r || r.status !== 'active') return;
      r.status = 'released';
      for (const item of r.items) {
        const c = this.get(item.budgetId, item.periodStart);
        c.reserved = Math.max(0, c.reserved - item.amount);
      }
    });
  }

  expire(now: number) {
    return this.mutex.run(() => {
      let n = 0;
      for (const r of this.reservations.values()) {
        if (r.status === 'active' && r.expiresAt <= now) {
          r.status = 'expired';
          for (const item of r.items) {
            const c = this.get(item.budgetId, item.periodStart);
            c.reserved = Math.max(0, c.reserved - item.amount);
          }
          n++;
        }
      }
      return n;
    });
  }

  async counter(budgetId: string, periodStart: number) {
    return { ...this.get(budgetId, periodStart) };
  }

  async markAlert(budgetId: string, periodStart: number, threshold: number) {
    const k = `${this.key(budgetId, periodStart)}#${threshold}`;
    if (this.alerts.has(k)) return false;
    this.alerts.add(k);
    return true;
  }

  activeReservationCount(): number {
    return [...this.reservations.values()].filter((r) => r.status === 'active').length;
  }
}

export interface ThresholdAlert {
  budgetId: string;
  budgetName: string;
  threshold: number;
  spent: NanoUsd;
  limit: NanoUsd;
  periodStart: number;
}

export type Admission =
  | { admitted: true; tierCap?: Tier }
  | { admitted: false; retryAt: number; reason: string };

export interface BudgetGateOptions {
  store: BudgetStore;
  timeZone: string;
  clock?: Clock;
  /** Reservations expire if a call never settles (the process died mid-call). */
  reservationTtlMs?: number;
  /** Safety factor applied to estimates when reserving. */
  safetyFactor?: number;
  powerMode?: () => PowerMode;
  systemState?: () => SystemState;
  /** Local hours [start, end) when deferrable work runs in economy mode. */
  nightlyWindow?: [number, number];
  onThreshold?: (alert: ThresholdAlert) => void;
}

export function budgetApplies(budget: Budget, req: { priority: PriorityClass; providerId?: string; route?: string }): boolean {
  switch (budget.scope.type) {
    case 'global':
      return true;
    case 'provider':
      return req.providerId === budget.scope.providerId;
    case 'route':
      return req.route === budget.scope.route;
    case 'priority':
      return budget.scope.priorities.includes(req.priority);
  }
}

export function effectiveLimit(budget: Budget, priority: PriorityClass): NanoUsd {
  return priority === 'interactive' ? budget.limit : Math.max(0, budget.limit - (budget.interactiveReserve ?? 0));
}

/**
 * Enforces budgets before calls happen. Every model call reserves its estimate on all
 * applicable budgets at once, then settles to the actual cost (architecture §8.4).
 */
export class BudgetGate {
  private readonly o: Required<Omit<BudgetGateOptions, 'onThreshold' | 'powerMode' | 'systemState'>> &
    Pick<BudgetGateOptions, 'onThreshold' | 'powerMode' | 'systemState'>;

  constructor(options: BudgetGateOptions) {
    this.o = {
      clock: systemClock,
      reservationTtlMs: 10 * MINUTE,
      safetyFactor: 1.25,
      nightlyWindow: [2, 6],
      ...options,
    };
  }

  async reserve(req: ReserveRequest): Promise<ReserveResult> {
    const now = this.o.clock.now();
    const amount = Math.ceil(req.estimate * this.o.safetyFactor);
    const budgets = (await this.o.store.listBudgets()).filter((b) => budgetApplies(b, req));
    const items: ReservationItem[] = budgets.map((b) => ({
      budgetId: b.id,
      periodStart: periodStart(b.period, now, this.o.timeZone),
      amount,
      effectiveLimit: effectiveLimit(b, req.priority),
    }));

    const reservationId = uuidv7(now);
    const result = await this.o.store.tryReserve({ reservationId, requestId: req.requestId, items, expiresAt: now + this.o.reservationTtlMs });
    if (result.ok) return { ok: true, reservationId, budgetIds: budgets.map((b) => b.id) };

    const budget = budgets.find((b) => b.id === result.budgetId)!;
    return {
      ok: false,
      action: isBackground(req.priority) ? budget.onLimit.background : budget.onLimit.interactive,
      budgetId: budget.id,
      budgetName: budget.name,
      retryAt: nextPeriodStart(budget.period, now, this.o.timeZone),
      spent: result.counter.spent,
      reserved: result.counter.reserved,
      limit: effectiveLimit(budget, req.priority),
    };
  }

  async settle(reservationId: string, actual: NanoUsd): Promise<void> {
    const updates = await this.o.store.settle(reservationId, actual);
    if (!this.o.onThreshold || updates.length === 0) return;
    const budgets = new Map((await this.o.store.listBudgets()).map((b) => [b.id, b]));
    for (const u of updates) {
      const b = budgets.get(u.budgetId);
      if (!b || b.limit <= 0) continue;
      const percent = (u.counter.spent / b.limit) * 100;
      for (const threshold of [...b.softThresholds].sort((x, y) => x - y)) {
        if (percent >= threshold && (await this.o.store.markAlert(b.id, u.periodStart, threshold))) {
          this.o.onThreshold({ budgetId: b.id, budgetName: b.name, threshold, spent: u.counter.spent, limit: b.limit, periodStart: u.periodStart });
        }
      }
    }
  }

  release(reservationId: string): Promise<void> {
    return this.o.store.release(reservationId);
  }

  /** Called every minute by the scheduler. */
  sweepExpired(): Promise<number> {
    return this.o.store.expire(this.o.clock.now());
  }

  /**
   * Cheap pre-check before a background job starts (Phase 1 plan §7.5).
   * Refused jobs are rescheduled for `retryAt`, never dropped.
   */
  async admit(priority: PriorityClass): Promise<Admission> {
    const now = this.o.clock.now();
    if (this.o.systemState?.() === 'stopped') {
      return { admitted: false, retryAt: now + MINUTE, reason: 'system stopped' };
    }

    const mode = this.o.powerMode?.() ?? 'normal';
    let tierCap: Tier | undefined;
    if (mode === 'background_paused' && isBackground(priority)) {
      return { admitted: false, retryAt: now + 15 * MINUTE, reason: 'background work is paused' };
    }
    if (mode === 'economy') {
      if (priority === 'deferrable' && !this.inNightlyWindow(now)) {
        return { admitted: false, retryAt: this.nextNightlyWindow(now), reason: 'economy mode: deferrable work waits for the nightly window' };
      }
      tierCap = priority === 'routine' || priority === 'deferrable' ? 'fast' : 'balanced';
    }

    for (const b of (await this.o.store.listBudgets()).filter((x) => x.scope.type === 'global' || (x.scope.type === 'priority' && x.scope.priorities.includes(priority)))) {
      const start = periodStart(b.period, now, this.o.timeZone);
      const c = await this.o.store.counter(b.id, start);
      if (c.spent + c.reserved >= effectiveLimit(b, priority)) {
        return { admitted: false, retryAt: nextPeriodStart(b.period, now, this.o.timeZone), reason: `budget "${b.name}" is exhausted` };
      }
    }
    return tierCap ? { admitted: true, tierCap } : { admitted: true };
  }

  async status(): Promise<{ budget: Budget; periodStart: number; resetsAt: number; counter: Counter; percent: number }[]> {
    const now = this.o.clock.now();
    const out = [];
    for (const b of await this.o.store.listBudgets()) {
      const start = periodStart(b.period, now, this.o.timeZone);
      const counter = await this.o.store.counter(b.id, start);
      out.push({ budget: b, periodStart: start, resetsAt: nextPeriodStart(b.period, now, this.o.timeZone), counter, percent: b.limit > 0 ? (counter.spent / b.limit) * 100 : 0 });
    }
    return out;
  }

  private inNightlyWindow(now: number): boolean {
    const { hour } = localParts(now, this.o.timeZone);
    const [start, end] = this.o.nightlyWindow;
    return hour >= start && hour < end;
  }

  private nextNightlyWindow(now: number): number {
    // Step forward in 15-minute increments until inside the window (at most ~1 day of steps).
    let t = now;
    for (let i = 0; i < 24 * 4 + 1; i++) {
      t += 15 * MINUTE;
      if (this.inNightlyWindow(t)) return t;
    }
    return now + 24 * 60 * MINUTE;
  }
}
