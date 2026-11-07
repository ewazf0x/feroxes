import type { ModelRouter } from '@feroxes/llm';
import { type Clock, DAY, type PriorityClass, systemClock } from '@feroxes/shared';
import type { TranscriptMessage } from './extraction.ts';
import { clamp01, cosine } from './scoring.ts';
import type { MemoryService } from './service.ts';
import type { Memory } from './types.ts';

export const SUMMARY_PROMPT_VERSION = 'session-summary-v1';
export const DIGEST_PROMPT_VERSION = 'daily-digest-v1';

const SESSION_SYSTEM = `Summarize this conversation between the owner and Feroxes (their assistant) for the owner's long-term memory.
Write 2–6 sentences in third person: what was discussed, decisions, open questions, anything promised.
Start with a short title on the first line, then a blank line, then the summary. No bullet lists.`;

const DIGEST_SYSTEM = `Write the owner's daily digest from these conversation summaries.
First line: a short title for the day. Then 3–8 sentences covering the main threads, decisions and open loops. Third person.`;

export interface NightlyReport {
  merged: { survivor: string; merged: string[] }[];
  importanceUpdated: number;
  coreTokens: number;
  digestId?: string;
  costNanoUsd: number;
}

/**
 * Scheduled, non-destructive consolidation (architecture §7.3, Phase 1 plan §7.10).
 * Everything here adds rows and links; no source is ever deleted.
 */
export class ConsolidationService {
  private readonly router: ModelRouter;
  private readonly memory: MemoryService;
  private readonly clock: Clock;

  constructor(deps: { router: ModelRouter; memory: MemoryService; clock?: Clock }) {
    this.router = deps.router;
    this.memory = deps.memory;
    this.clock = deps.clock ?? systemClock;
  }

  /** Session idle → one conversation episode linked to its messages. */
  async summarizeSession(input: { sessionId: string; messages: TranscriptMessage[]; priority?: PriorityClass; signal?: AbortSignal }): Promise<Memory | undefined> {
    const msgs = input.messages.filter((m) => m.content.trim());
    if (msgs.length < 2) return undefined;
    const transcript = msgs.map((m) => `${m.role === 'user' ? 'Owner' : 'Feroxes'}: ${m.content}`).join('\n').slice(-60_000);
    const result = await this.router.generate({
      route: 'session.summarize',
      priority: input.priority ?? 'routine',
      messages: [{ role: 'system', content: SESSION_SYSTEM }, { role: 'user', content: transcript }],
      sensitivity: 'private',
      attribution: { taskType: 'memory.consolidate', promptVersion: SUMMARY_PROMPT_VERSION, sessionId: input.sessionId },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const [titleLine, ...rest] = result.text.trim().split('\n');
    const summary = rest.join('\n').trim() || titleLine || '';
    if (!summary) return undefined;
    return this.memory.remember(
      {
        kind: 'conversation',
        title: (titleLine ?? 'Conversation').replace(/^#+\s*/, '').slice(0, 120),
        content: summary,
        importance: 0.4,
        confidence: 0.9,
        sensitivity: 'private',
        source: 'consolidated',
        occurredAt: msgs[0]!.createdAt,
        structured: { sessionId: input.sessionId, messageCount: msgs.length, endedAt: msgs.at(-1)!.createdAt },
        sources: [{ sourceType: 'session', sourceId: input.sessionId }, ...msgs.map((m) => ({ sourceType: 'message' as const, sourceId: m.id }))],
      },
      'consolidator',
      { reason: 'session summary' },
    );
  }

  async nightly(opts: { priority?: PriorityClass; mergeThreshold?: number } = {}): Promise<NightlyReport> {
    const report: NightlyReport = { merged: [], importanceUpdated: 0, coreTokens: 0, costNanoUsd: 0 };
    await this.mergeDuplicates(report, opts.mergeThreshold ?? 0.92);
    report.importanceUpdated = await this.recomputeImportance();
    const digest = await this.dailyDigest(opts.priority ?? 'deferrable', report);
    if (digest) report.digestId = digest.id;
    report.coreTokens = (await this.memory.regenerateCore()).tokenCount;
    return report;
  }

  /**
   * Near-duplicates (same layer, cosine ≥ threshold, sharing an entity or both entity-free) merge
   * into the strongest one. The others stay in the store as `merged`, linked to the survivor.
   */
  private async mergeDuplicates(report: NightlyReport, threshold: number) {
    const active = await this.memory.store.list({ statuses: ['active'], layers: ['semantic', 'procedural'] });
    const vectors = new Map<string, number[]>();
    for (const m of active) {
      const v = await this.memory.embeddingOf(m.id);
      if (v) vectors.set(m.id, v);
    }
    const strength = (m: Memory) => (m.source === 'owner_asserted' ? 2 : 0) + m.confidence + m.evidenceCount * 0.05 - m.createdAt / 1e15;
    const done = new Set<string>();
    for (const a of active) {
      if (done.has(a.id) || !vectors.has(a.id)) continue;
      const group = [a];
      for (const b of active) {
        if (b.id === a.id || done.has(b.id) || b.layer !== a.layer || !vectors.has(b.id)) continue;
        const sameEntities = a.entityIds.length === 0 && b.entityIds.length === 0 ? true : a.entityIds.some((id) => b.entityIds.includes(id));
        if (sameEntities && cosine(vectors.get(a.id)!, vectors.get(b.id)!) >= threshold) group.push(b);
      }
      if (group.length < 2) continue;
      group.sort((x, y) => strength(y) - strength(x));
      const [survivor, ...others] = group;
      for (const o of others) {
        await this.memory.store.put({ ...o, status: 'merged', mergedIntoId: survivor!.id, updatedAt: this.clock.now() });
        await this.memory.store.addLink({ fromId: o.id, toId: survivor!.id, type: 'supports' });
        await this.memory.addEvidence(survivor!.id, 'consolidator', `merged duplicate ${o.id}`);
        done.add(o.id);
      }
      done.add(survivor!.id);
      report.merged.push({ survivor: survivor!.id, merged: others.map((o) => o.id) });
    }
  }

  /** importance = 0.6·base + 0.2·evidence + 0.2·links; pinned and owner-stated never drop below base. */
  private async recomputeImportance(): Promise<number> {
    let n = 0;
    for (const m of await this.memory.store.list({ statuses: ['active'] })) {
      const base = (m.structured?.baseImportance as number | undefined) ?? m.importance;
      const links = (await this.memory.store.links(m.id)).length;
      let next = clamp01(0.6 * base + 0.2 * Math.min(1, Math.log10(1 + m.evidenceCount)) + 0.2 * Math.min(1, links / 5));
      if (m.pinned || m.source === 'owner_asserted') next = Math.max(next, base);
      if (Math.abs(next - m.importance) > 0.01) {
        await this.memory.store.put({ ...m, importance: next, structured: { ...(m.structured ?? {}), baseImportance: base } });
        n++;
      }
    }
    return n;
  }

  private async dailyDigest(priority: PriorityClass, report: NightlyReport): Promise<Memory | undefined> {
    const now = this.clock.now();
    const episodes = (await this.memory.store.list({ statuses: ['active'], kinds: ['conversation'] })).filter((m) => (m.occurredAt ?? 0) >= now - DAY);
    if (episodes.length < 2) return undefined;
    const result = await this.router.generate({
      route: 'memory.consolidate',
      priority,
      messages: [{ role: 'system', content: DIGEST_SYSTEM }, { role: 'user', content: episodes.map((e) => `- ${e.title ?? ''}: ${e.content}`).join('\n') }],
      sensitivity: 'private',
      attribution: { taskType: 'memory.consolidate', promptVersion: DIGEST_PROMPT_VERSION },
    });
    report.costNanoUsd += result.finish.costNanoUsd;
    const [title, ...rest] = result.text.trim().split('\n');
    const digest = await this.memory.remember(
      { kind: 'digest_day', title: (title ?? 'Daily digest').slice(0, 120), content: rest.join('\n').trim() || title || '', importance: 0.5, confidence: 0.9, sensitivity: 'private', source: 'consolidated', occurredAt: now - DAY / 2, sources: episodes.map((e) => ({ sourceType: 'memory' as const, sourceId: e.id })) },
      'consolidator',
      { reason: 'daily digest' },
    );
    for (const e of episodes) await this.memory.store.addLink({ fromId: e.id, toId: digest.id, type: 'part_of' });
    return digest;
  }
}
