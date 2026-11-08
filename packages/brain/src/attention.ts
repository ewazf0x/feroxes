import { type Clock, DAY, localParts, systemClock, uuidv7 } from '@feroxes/shared';
import type { DocStore } from './docs.ts';

/**
 * Ambient intelligence: Feroxes stays almost invisible until it matters. Every proactive message
 * goes through the attention manager, which delivers it now, holds it for the next digest, or
 * keeps it silent, based on urgency, relevance, the owner's mode and a daily interruption budget.
 */
export type AttentionMode = 'ambient' | 'focus' | 'silent' | 'proactive';

export interface Signal {
  title: string;
  body: string;
  urgency: 'low' | 'normal' | 'high';
  /** 0..1: how much this matters to the owner's goals and situation. */
  relevance?: number;
  /** Security and money problems always get through. */
  category?: 'security' | 'money' | 'health' | 'goal' | 'device' | 'info';
}

export interface Delivery {
  id: string;
  at: number;
  signal: Signal;
  decision: 'now' | 'digest' | 'silent';
  reason: string;
}

const BUDGET: Record<AttentionMode, number> = { proactive: 12, ambient: 6, focus: 2, silent: 0 };

export class AttentionManager {
  private readonly docs: DocStore;
  private readonly clock: Clock;
  private readonly timeZone: string;
  private readonly deliver: (s: Signal) => void;
  private readonly quiet: () => number[];
  private mode: AttentionMode;

  constructor(deps: { docs: DocStore; clock?: Clock; timeZone: string; deliver: (s: Signal) => void; quietHours?: () => number[]; mode?: AttentionMode }) {
    this.docs = deps.docs;
    this.clock = deps.clock ?? systemClock;
    this.timeZone = deps.timeZone;
    this.deliver = deps.deliver;
    this.quiet = deps.quietHours ?? (() => [23, 0, 1, 2, 3, 4, 5, 6]);
    this.mode = deps.docs.get<{ id: string; mode: AttentionMode }>('attention', 'mode')?.mode ?? deps.mode ?? 'ambient';
  }

  get currentMode(): AttentionMode {
    return this.mode;
  }

  setMode(mode: AttentionMode): void {
    this.mode = mode;
    this.docs.put('attention', { id: 'mode', mode });
  }

  /** Decides and records what happens to a signal. Returns the decision. */
  offer(signal: Signal): Delivery {
    const now = this.clock.now();
    const today = this.log().filter((d) => d.decision === 'now' && d.at > now - DAY && !this.always(d.signal));
    const hour = localParts(now, this.timeZone).hour;
    const quiet = this.quiet().includes(hour);
    const score = (signal.urgency === 'high' ? 0.8 : signal.urgency === 'normal' ? 0.5 : 0.2) * (0.5 + 0.5 * (signal.relevance ?? 0.6));
    let decision: Delivery['decision'];
    let reason: string;
    if (this.always(signal)) {
      decision = 'now';
      reason = `${signal.category} alerts always get through`;
    } else if (this.mode === 'silent') {
      decision = signal.urgency === 'low' ? 'silent' : 'digest';
      reason = 'silent observation mode';
    } else if (quiet && signal.urgency !== 'high') {
      decision = 'digest';
      reason = 'quiet hours';
    } else if (score < (this.mode === 'focus' ? 0.6 : this.mode === 'proactive' ? 0.2 : 0.35)) {
      decision = signal.urgency === 'low' && (signal.relevance ?? 0.6) < 0.3 ? 'silent' : 'digest';
      reason = `not worth an interruption (${score.toFixed(2)})`;
    } else if (today.length >= BUDGET[this.mode]) {
      decision = 'digest';
      reason = `interruption budget for today used (${BUDGET[this.mode]})`;
    } else {
      decision = 'now';
      reason = `important enough (${score.toFixed(2)})`;
    }
    const d: Delivery = { id: uuidv7(now), at: now, signal, decision, reason };
    this.docs.put('delivery', d, now);
    if (decision === 'now') this.deliver(signal);
    return d;
  }

  /** Items held back for the next briefing; taking them marks them delivered. */
  takeDigest(): Signal[] {
    const held = this.docs.list<Delivery & { digested?: boolean }>('delivery').filter((d) => d.decision === 'digest' && !d.digested);
    for (const d of held) this.docs.put('delivery', { ...d, digested: true });
    return held.map((d) => d.signal);
  }

  log(days = 1): Delivery[] {
    const since = this.clock.now() - days * DAY;
    return this.docs.list<Delivery>('delivery').filter((d) => d.at >= since);
  }

  private always(s: Signal) {
    return s.urgency === 'high' && (s.category === 'security' || s.category === 'money');
  }
}

// =============================================================================================
// Silent observation: learns how the owner uses the PC and phone from app switches and activity
// events only (never keystrokes or screen contents). Aggregates per day, inspectable, deletable.
// =============================================================================================

export interface UsageDay {
  id: string; // YYYY-MM-DD
  apps: Record<string, number>; // minutes in the foreground
  activeMinutes: number;
  firstActive?: number;
  lastActive?: number;
  focusBlocks: { start: number; minutes: number; app: string }[];
}

export class ObservationService {
  private readonly docs: DocStore;
  private readonly clock: Clock;
  private current?: { app: string; since: number; device: string };
  enabled = true;

  constructor(deps: { docs: DocStore; clock?: Clock }) {
    this.docs = deps.docs;
    this.clock = deps.clock ?? systemClock;
  }

  /** Feed device events: foreground_changed { app }, screen_locked, owner_activity. */
  observe(e: { event: string; data: Record<string, unknown>; deviceName: string; at?: number }): void {
    if (!this.enabled) return;
    const at = e.at ?? this.clock.now();
    if (e.event === 'foreground_changed' || e.event === 'screen_locked') {
      this.closeCurrent(at);
      if (e.event === 'foreground_changed' && typeof e.data.app === 'string') this.current = { app: e.data.app, since: at, device: e.deviceName };
    }
  }

  private closeCurrent(at: number) {
    const c = this.current;
    if (!c) return;
    const minutes = Math.min(240, (at - c.since) / 60_000);
    this.current = undefined;
    if (minutes < 0.1) return;
    const id = new Date(c.since).toISOString().slice(0, 10);
    const day = this.docs.get<UsageDay>('usage_day', id) ?? { id, apps: {}, activeMinutes: 0, focusBlocks: [] };
    day.apps[c.app] = round1((day.apps[c.app] ?? 0) + minutes);
    day.activeMinutes = round1(day.activeMinutes + minutes);
    day.firstActive = Math.min(day.firstActive ?? c.since, c.since);
    day.lastActive = Math.max(day.lastActive ?? at, at);
    if (minutes >= 25) day.focusBlocks.push({ start: c.since, minutes: round1(minutes), app: c.app });
    this.docs.put('usage_day', day);
  }

  days(n = 7): UsageDay[] {
    return this.docs.list<UsageDay>('usage_day').sort((a, b) => a.id.localeCompare(b.id)).slice(-n);
  }

  summary(n = 7): string {
    const days = this.days(n);
    if (!days.length) return '';
    const totals: Record<string, number> = {};
    for (const d of days) for (const [app, m] of Object.entries(d.apps)) totals[app] = (totals[app] ?? 0) + m;
    const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const focus = days.flatMap((d) => d.focusBlocks);
    return `Observed device use (last ${days.length} day(s)): ${top.map(([a, m]) => `${a} ${(m / 60).toFixed(1)} h`).join(', ')}; ${focus.length} focus block(s) of 25+ minutes${focus.length ? `, longest ${Math.max(...focus.map((f) => f.minutes))} min in ${focus.sort((a, b) => b.minutes - a.minutes)[0]!.app}` : ''}.`;
  }

  forget(): void {
    for (const d of this.docs.list<UsageDay>('usage_day')) this.docs.delete('usage_day', d.id);
  }
}

const round1 = (x: number) => Math.round(x * 10) / 10;
