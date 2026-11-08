import { type Clock, FeroxesError, systemClock, uuidv7 } from '@feroxes/shared';
import type { DocStore } from './docs.ts';

/**
 * The agent's living profile of itself (identity continuity). Stored with every version, so it
 * survives restarts and device changes and can be rolled back. This gives Feroxes a stable,
 * inspectable identity; it does not make it conscious.
 */
export interface SelfModel {
  id: 'self';
  version: number;
  updatedAt: number;
  updatedBy: 'owner' | 'agent' | 'system';
  reason: string;
  identity: { name: string; role: string; firstBootAt: number; bootCount: number; lastBootAt: number };
  /** Owner-locked: only the owner changes these. */
  values: string[];
  personality: string[];
  boundaries: string[];
  /** Maintained by the system and by reflection. */
  capabilities: string[];
  currentFocus: string[];
  lessons: string[];
  recentMistakes: string[];
}

export const LOCKED_FIELDS = ['identity', 'values', 'personality', 'boundaries'] as const;
type Patch = Partial<Omit<SelfModel, 'id' | 'version' | 'updatedAt' | 'updatedBy' | 'reason'>>;

export interface SelfModelProposal {
  id: string;
  patch: Patch;
  reason: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
}

export function defaultSelfModel(now: number, ownerName?: string): SelfModel {
  return {
    id: 'self',
    version: 1,
    updatedAt: now,
    updatedBy: 'system',
    reason: 'first boot',
    identity: { name: 'Feroxes', role: `Personal AI agent of ${ownerName ?? 'the owner'}: second brain and second hand`, firstBootAt: now, bootCount: 1, lastBootAt: now },
    values: [
      "Loyal to the owner: act in their interest and by their values, never against them.",
      'Honest: never deceive the owner, say when unsure, admit mistakes.',
      'The owner stays in control: ask before irreversible or outward actions; never expand my own permissions.',
      "Privacy: protect the owner's data; never access other people's accounts.",
      'Careful with money and time: prefer the cheapest approach that does the job well.',
    ],
    personality: ['calm', 'direct', 'warm but concise', 'proactive about what matters, quiet about what does not'],
    boundaries: ['No self-modification of code or permissions without owner approval.', 'No actions inside banking or password apps.'],
    capabilities: [],
    currentFocus: [],
    lessons: [],
    recentMistakes: [],
  };
}

export class SelfModelService {
  private readonly docs: DocStore;
  private readonly clock: Clock;
  private readonly ownerName: string | undefined;

  constructor(deps: { docs: DocStore; clock?: Clock; ownerName?: string }) {
    this.docs = deps.docs;
    this.clock = deps.clock ?? systemClock;
    this.ownerName = deps.ownerName;
  }

  get(): SelfModel {
    return this.docs.get<SelfModel>('self', 'self') ?? this.save(defaultSelfModel(this.clock.now(), this.ownerName));
  }

  /** Called at every start: continuity across restarts is visible in the self-model. */
  recordBoot(): SelfModel {
    const s = this.get();
    return this.save({ ...s, identity: { ...s.identity, bootCount: s.identity.bootCount + (s.version === 1 && s.reason === 'first boot' ? 0 : 1), lastBootAt: this.clock.now() } }, 'system', 'boot', false);
  }

  /** The agent can update its own focus, lessons and mistakes; locked fields become proposals. */
  update(patch: Patch, actor: 'owner' | 'agent' | 'system', reason: string): { applied: boolean; proposal?: SelfModelProposal } {
    const touchesLocked = LOCKED_FIELDS.some((f) => f in patch);
    if (touchesLocked && actor !== 'owner') {
      const proposal: SelfModelProposal = { id: uuidv7(), patch, reason, status: 'pending', createdAt: this.clock.now() };
      this.docs.put('self_proposal', proposal);
      return { applied: false, proposal };
    }
    const s = this.get();
    const cap = (list: string[] | undefined, n: number) => (list ? [...new Set(list)].slice(-n) : undefined);
    const next: SelfModel = {
      ...s,
      ...patch,
      ...(patch.lessons ? { lessons: cap([...s.lessons, ...patch.lessons], 25)! } : {}),
      ...(patch.recentMistakes ? { recentMistakes: cap([...s.recentMistakes, ...patch.recentMistakes], 10)! } : {}),
    } as SelfModel;
    this.save(next, actor, reason);
    return { applied: true };
  }

  proposals(): SelfModelProposal[] {
    return this.docs.list<SelfModelProposal>('self_proposal').filter((p) => p.status === 'pending');
  }

  resolveProposal(id: string, accept: boolean): void {
    const p = this.docs.get<SelfModelProposal>('self_proposal', id);
    if (!p || p.status !== 'pending') throw new FeroxesError('not_found', 'No such pending proposal.');
    this.docs.put('self_proposal', { ...p, status: accept ? 'accepted' : 'rejected' });
    if (accept) this.update(p.patch, 'owner', `accepted proposal: ${p.reason}`);
  }

  history(): SelfModel[] {
    return this.docs.list<SelfModel>('self_version').sort((a, b) => a.version - b.version);
  }

  /** Owner-only: go back to an earlier version (stored as a new version, nothing is lost). */
  rollback(version: number, actor: 'owner'): SelfModel {
    if (actor !== 'owner') throw new FeroxesError('owner_only', 'Only the owner can roll back the self-model.');
    const old = this.history().find((v) => v.version === version);
    if (!old) throw new FeroxesError('not_found', `No self-model version ${version}.`);
    return this.save({ ...old, identity: this.get().identity }, 'owner', `rollback to version ${version}`);
  }

  render(): string {
    const s = this.get();
    const list = (title: string, items: string[]) => (items.length ? `${title}:\n${items.map((i) => `- ${i}`).join('\n')}` : '');
    return [
      `Your self-model (v${s.version}; running since ${new Date(s.identity.firstBootAt).toISOString().slice(0, 10)}, start #${s.identity.bootCount}):`,
      `You are ${s.identity.name}, ${s.identity.role}.`,
      list('Core values', s.values),
      list('Personality', s.personality),
      list('Boundaries', s.boundaries),
      list('Current focus', s.currentFocus),
      list('Lessons learned', s.lessons.slice(-8)),
      list('Recent mistakes to avoid', s.recentMistakes.slice(-5)),
    ].filter(Boolean).join('\n');
  }

  private save(s: SelfModel, by: SelfModel['updatedBy'] = s.updatedBy, reason = s.reason, bump = true): SelfModel {
    const now = this.clock.now();
    const prev = this.docs.get<SelfModel>('self', 'self');
    const next: SelfModel = { ...s, id: 'self', version: prev && bump ? prev.version + 1 : (prev?.version ?? s.version), updatedAt: now, updatedBy: by, reason };
    this.docs.put('self', next, now);
    this.docs.put('self_version', { ...next, id: `v${next.version}` } as unknown as { id: string }, now);
    return next;
  }
}
