import { type Clock, DAY, FeroxesError, HOUR, systemClock, uuidv7 } from '@feroxes/shared';
import type { DocStore } from './docs.ts';

export type Horizon = 'now' | 'today' | 'week' | 'month' | 'long';
export const HORIZONS: Horizon[] = ['now', 'today', 'week', 'month', 'long'];

export interface Goal {
  id: string;
  title: string;
  description?: string;
  horizon: Horizon;
  parentId?: string;
  status: 'proposed' | 'active' | 'paused' | 'done' | 'dropped';
  priority: number; // 1 (highest) … 5
  source: 'owner' | 'agent';
  /** inform = track and tell; suggest = propose next steps; act = work on it in the background (policy still applies). */
  autonomy: 'inform' | 'suggest' | 'act';
  successCriteria?: string;
  progress: number; // 0..1
  dueAt?: number;
  nextCheckAt?: number;
  notes: { at: number; text: string; by: 'owner' | 'agent' }[];
  createdAt: number;
  updatedAt: number;
}

const CHECK_EVERY: Record<Horizon, number> = { now: HOUR, today: 4 * HOUR, week: DAY, month: 3 * DAY, long: 7 * DAY };

/**
 * Goal hierarchy (owner goals + agent-proposed sub-goals) across horizons. The agent can only
 * propose goals; the owner activates them. That keeps initiative without self-assigned missions.
 */
export class GoalService {
  private readonly docs: DocStore;
  private readonly clock: Clock;

  constructor(deps: { docs: DocStore; clock?: Clock }) {
    this.docs = deps.docs;
    this.clock = deps.clock ?? systemClock;
  }

  create(input: Pick<Goal, 'title' | 'horizon'> & Partial<Pick<Goal, 'description' | 'parentId' | 'priority' | 'autonomy' | 'successCriteria' | 'dueAt'>>, by: 'owner' | 'agent'): Goal {
    const now = this.clock.now();
    if (input.parentId && !this.get(input.parentId)) throw new FeroxesError('not_found', `No parent goal ${input.parentId}.`);
    const goal: Goal = {
      id: uuidv7(now),
      title: input.title.trim(),
      ...(input.description ? { description: input.description } : {}),
      horizon: input.horizon,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      status: by === 'owner' ? 'active' : 'proposed',
      priority: Math.min(5, Math.max(1, input.priority ?? 3)),
      source: by,
      autonomy: input.autonomy ?? 'suggest',
      ...(input.successCriteria ? { successCriteria: input.successCriteria } : {}),
      progress: 0,
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
      nextCheckAt: now + CHECK_EVERY[input.horizon],
      notes: [],
      createdAt: now,
      updatedAt: now,
    };
    this.docs.put('goal', goal, now);
    return goal;
  }

  get(id: string): Goal | undefined {
    return this.docs.get<Goal>('goal', id) ?? this.list().find((g) => g.id.endsWith(id));
  }

  list(filter: { status?: Goal['status'][] } = {}): Goal[] {
    return this.docs.list<Goal>('goal').filter((g) => !filter.status || filter.status.includes(g.status));
  }

  /** Owner decisions: accept or reject a proposal, pause, finish, drop, change autonomy. */
  setStatus(id: string, status: Goal['status'], by: 'owner' | 'agent'): Goal {
    const g = this.require(id);
    if (by === 'agent' && (g.status === 'proposed' || status === 'active' || status === 'dropped')) {
      throw new FeroxesError('owner_only', 'Only the owner can activate, accept or drop goals.');
    }
    return this.save({ ...g, status, ...(status === 'done' ? { progress: 1 } : {}) });
  }

  setAutonomy(id: string, autonomy: Goal['autonomy'], by: 'owner'): Goal {
    if (by !== 'owner') throw new FeroxesError('owner_only', 'Only the owner sets goal autonomy.');
    return this.save({ ...this.require(id), autonomy });
  }

  progress(id: string, progress: number, note: string, by: 'owner' | 'agent'): Goal {
    const g = this.require(id);
    const now = this.clock.now();
    return this.save({ ...g, progress: Math.min(1, Math.max(0, progress)), notes: [...g.notes, { at: now, text: note.slice(0, 1000), by }].slice(-30), nextCheckAt: now + CHECK_EVERY[g.horizon] });
  }

  /** Active goals whose next check is due, highest priority first (for the pursuit daemon). */
  due(now = this.clock.now()): Goal[] {
    return this.list({ status: ['active'] }).filter((g) => (g.nextCheckAt ?? 0) <= now).sort((a, b) => a.priority - b.priority);
  }

  /** Simple conflict surfacing: overlapping deadlines among high-priority goals, or overdue ones. */
  conflicts(now = this.clock.now()): string[] {
    const active = this.list({ status: ['active'] });
    const out: string[] = [];
    for (const g of active) if (g.dueAt && g.dueAt < now && g.progress < 1) out.push(`"${g.title}" is overdue.`);
    const urgent = active.filter((g) => g.dueAt && g.dueAt - now < 2 * DAY && g.priority <= 2);
    if (urgent.length > 2) out.push(`${urgent.length} high-priority goals are due within two days: ${urgent.map((g) => g.title).join(', ')}.`);
    return out;
  }

  render(limit = 12): string {
    const active = this.list({ status: ['active'] }).sort((a, b) => HORIZONS.indexOf(a.horizon) - HORIZONS.indexOf(b.horizon) || a.priority - b.priority);
    const proposed = this.list({ status: ['proposed'] });
    if (!active.length && !proposed.length) return '';
    const line = (g: Goal) => `- [g:${g.id.slice(-6)}] (${g.horizon}, P${g.priority}, ${Math.round(g.progress * 100)}%, ${g.autonomy}) ${g.title}${g.dueAt ? ` — due ${new Date(g.dueAt).toISOString().slice(0, 10)}` : ''}${g.parentId ? ` (part of g:${g.parentId.slice(-6)})` : ''}`;
    return [`The owner's goals:`, ...active.slice(0, limit).map(line), ...(proposed.length ? [`Proposed by you, waiting for the owner: ${proposed.map((g) => g.title).join('; ')}`] : []), ...this.conflicts().map((c) => `Attention: ${c}`)].join('\n');
  }

  private require(id: string): Goal {
    const g = this.get(id);
    if (!g) throw new FeroxesError('not_found', `No goal ${id}.`);
    return g;
  }

  private save(g: Goal): Goal {
    const next = { ...g, updatedAt: this.clock.now() };
    this.docs.put('goal', next, next.updatedAt);
    return next;
  }
}

export interface Skill {
  id: string;
  name: string;
  /** When to use it, in the owner's words. */
  trigger: string;
  steps: string[];
  tools: string[];
  status: 'proposed' | 'active' | 'retired';
  source: 'reflection' | 'owner';
  uses: number;
  createdAt: number;
}

/** Skill library: successful multi-step workflows packaged for reuse (activated by the owner). */
export class SkillLibrary {
  private readonly docs: DocStore;
  private readonly clock: Clock;

  constructor(deps: { docs: DocStore; clock?: Clock }) {
    this.docs = deps.docs;
    this.clock = deps.clock ?? systemClock;
  }

  propose(input: Pick<Skill, 'name' | 'trigger' | 'steps' | 'tools'>, source: Skill['source']): Skill {
    const existing = this.list().find((s) => s.name.toLowerCase() === input.name.toLowerCase() && s.status !== 'retired');
    if (existing) return existing;
    const skill: Skill = { id: uuidv7(), ...input, status: source === 'owner' ? 'active' : 'proposed', source, uses: 0, createdAt: this.clock.now() };
    this.docs.put('skill', skill);
    return skill;
  }

  list(status?: Skill['status']): Skill[] {
    return this.docs.list<Skill>('skill').filter((s) => !status || s.status === status);
  }

  setStatus(id: string, status: Skill['status']): void {
    const s = this.docs.get<Skill>('skill', id);
    if (!s) throw new FeroxesError('not_found', `No skill ${id}.`);
    this.docs.put('skill', { ...s, status });
  }

  render(limit = 6): string {
    const active = this.list('active').slice(-limit);
    if (!active.length) return '';
    return `Your skills (proven workflows; follow them when the trigger fits):\n${active.map((s) => `- ${s.name} — when: ${s.trigger}\n  steps: ${s.steps.join(' → ')}`).join('\n')}`;
  }
}
