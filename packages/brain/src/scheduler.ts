import type { BudgetGate } from '@feroxes/metering';
import type { SystemControl } from '@feroxes/policy';
import { type Clock, type Logger, type PriorityClass, errorMessage, localParts, noopLogger, systemClock, zonedTime } from '@feroxes/shared';
import type { DocStore } from './docs.ts';

export interface Job {
  name: string;
  /** Run every N ms, or daily at local "HH:MM" in the owner's time zone. */
  every?: number;
  dailyAt?: string;
  /** Jobs that call models ask the budget for admission first; 'none' = model-free. */
  priority: PriorityClass | 'none';
  /** Keeps running while the system is stopped (backups only; they don't act on the world). */
  runWhenStopped?: boolean;
  run(): Promise<unknown>;
}

interface JobState {
  id: string;
  lastRunAt?: number;
  nextEligibleAt?: number;
  lastError?: string;
  lastResult?: string;
  runs: number;
}

/**
 * The background daemons' clock (event-driven core + periodic jobs). Persisted run times mean a
 * PC that was asleep catches up on missed daily jobs once, when it wakes.
 */
export class Scheduler {
  private readonly o: { jobs: Job[]; docs: DocStore; system: SystemControl; budget?: BudgetGate; clock: Clock; timeZone: string; logger: Logger };
  private running = false;

  constructor(deps: { jobs: Job[]; docs: DocStore; system: SystemControl; budget?: BudgetGate; clock?: Clock; timeZone: string; logger?: Logger }) {
    this.o = { clock: systemClock, logger: noopLogger, ...deps };
  }

  add(job: Job) {
    this.o.jobs.push(job);
  }

  state(name: string): JobState {
    return this.o.docs.get<JobState>('job', name) ?? { id: name, runs: 0 };
  }

  isDue(job: Job, now: number): boolean {
    const s = this.state(job.name);
    if (s.nextEligibleAt && s.nextEligibleAt > now) return false;
    if (job.every) return !s.lastRunAt || now - s.lastRunAt >= job.every;
    if (job.dailyAt) {
      const [h, m] = job.dailyAt.split(':').map(Number);
      const p = localParts(now, this.o.timeZone);
      let occurrence = zonedTime(this.o.timeZone, p.year, p.month, p.day, h ?? 0, m ?? 0);
      if (occurrence > now) occurrence -= 24 * 3_600_000; // the most recent past occurrence
      return !s.lastRunAt || s.lastRunAt < occurrence;
    }
    return false;
  }

  /** Called every minute. Runs due jobs one at a time; returns the names that ran. */
  async tick(): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    const ran: string[] = [];
    try {
      for (const job of this.o.jobs) {
        const now = this.o.clock.now();
        if (!this.isDue(job, now)) continue;
        if (this.o.system.stopped && !job.runWhenStopped) continue;
        const s = this.state(job.name);
        if (job.priority !== 'none' && this.o.budget) {
          const admission = await this.o.budget.admit(job.priority);
          if (!admission.admitted) {
            this.o.docs.put('job', { ...s, nextEligibleAt: admission.retryAt, lastError: `waiting: ${admission.reason}` });
            continue;
          }
        }
        try {
          const result = await job.run();
          this.o.docs.put('job', { id: job.name, lastRunAt: now, runs: s.runs + 1, ...(result !== undefined ? { lastResult: String(typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 500) } : {}) });
          ran.push(job.name);
        } catch (error) {
          this.o.logger.warn('job failed', { job: job.name, error: errorMessage(error) });
          // Retry in 15 minutes rather than hammering a failing provider.
          this.o.docs.put('job', { ...s, lastRunAt: now, nextEligibleAt: now + 15 * 60_000, lastError: errorMessage(error), runs: s.runs + 1 });
        }
      }
    } finally {
      this.running = false;
    }
    return ran;
  }

  start(intervalMs = 60_000): () => void {
    const t = setInterval(() => void this.tick(), intervalMs);
    t.unref();
    return () => clearInterval(t);
  }
}
