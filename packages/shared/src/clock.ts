/** Injectable time source, so budgets, decay and schedules are testable. */
export interface Clock {
  now(): number; // epoch milliseconds
}

export const systemClock: Clock = { now: () => Date.now() };

/** Manually advanced clock for tests and simulations. */
export class ManualClock implements Clock {
  private current: number;

  constructor(start: number | Date = Date.UTC(2026, 10, 7, 12, 0, 0)) {
    this.current = typeof start === 'number' ? start : start.getTime();
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(time: number | Date): void {
    this.current = typeof time === 'number' ? time : time.getTime();
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
