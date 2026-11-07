import { type Clock, type NanoUsd, type PowerMode, DAY, HOUR, systemClock, usd } from '@feroxes/shared';
import type { UsageLedger } from './ledger.ts';

export interface ModeChange {
  mode: PowerMode;
  previous: PowerMode;
  actor: 'owner' | 'system';
  reason: string;
  at: number;
}

/** Holds the current power mode. Persisted in `system_state` in production. */
export class PowerModeController {
  private current: PowerMode;
  private readonly listeners = new Set<(change: ModeChange) => void>();
  private readonly clock: Clock;

  constructor(initial: PowerMode = 'normal', clock: Clock = systemClock) {
    this.current = initial;
    this.clock = clock;
  }

  get mode(): PowerMode {
    return this.current;
  }

  set(mode: PowerMode, actor: ModeChange['actor'], reason: string): ModeChange | undefined {
    if (mode === this.current) return undefined;
    const change: ModeChange = { mode, previous: this.current, actor, reason, at: this.clock.now() };
    this.current = mode;
    for (const l of this.listeners) l(change);
    return change;
  }

  onChange(listener: (change: ModeChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface AnomalyResult {
  anomalous: boolean;
  lastHour: NanoUsd;
  trailingHourlyAverage: NanoUsd;
}

/**
 * Spend-rate anomaly check, run every few minutes: the last hour's spend above `factor`×
 * the trailing 7-day hourly average (and above a floor) means something is looping.
 */
export class SpendAnomalyDetector {
  private readonly ledger: UsageLedger;
  private readonly clock: Clock;
  private readonly factor: number;
  private readonly floor: NanoUsd;

  constructor(deps: { ledger: UsageLedger; clock?: Clock; factor?: number; floor?: NanoUsd }) {
    this.ledger = deps.ledger;
    this.clock = deps.clock ?? systemClock;
    this.factor = deps.factor ?? 3;
    this.floor = deps.floor ?? usd(0.25);
  }

  async check(): Promise<AnomalyResult> {
    const now = this.clock.now();
    // `to` is exclusive, so +1 includes calls recorded at this exact millisecond.
    const events = await this.ledger.query({ from: now - 7 * DAY - HOUR, to: now + 1 });
    let lastHour = 0;
    let trailing = 0;
    for (const e of events) {
      if (e.ts >= now - HOUR) lastHour += e.cost;
      else trailing += e.cost;
    }
    const trailingHourlyAverage = Math.round(trailing / (7 * 24));
    return { anomalous: lastHour > this.floor && lastHour > this.factor * trailingHourlyAverage, lastHour, trailingHourlyAverage };
  }
}
