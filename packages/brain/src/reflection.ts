import type { AgentStore, Run } from '@feroxes/agent';
import type { ModelRouter } from '@feroxes/llm';
import { type Clock, DAY, errorMessage, formatUsd, systemClock, uuidv7 } from '@feroxes/shared';
import * as z from 'zod/v4';
import type { DocStore } from './docs.ts';
import { type GoalService, HORIZONS, type SkillLibrary } from './goals.ts';
import type { SelfModelService } from './self-model.ts';

export const REFLECT_PROMPT_VERSION = 'reflect-v1';

const ReflectionSchema = z.object({
  summary: z.string().max(1500),
  lessons: z.array(z.string().max(300)).max(5).default([]),
  mistakes: z.array(z.string().max(300)).max(5).default([]),
  focus: z.array(z.string().max(200)).max(5).default([]),
  skills: z.array(z.object({ name: z.string().max(80), trigger: z.string().max(200), steps: z.array(z.string().max(200)).min(2).max(10), tools: z.array(z.string().max(60)).max(10).default([]) })).max(3).default([]),
  goal_suggestions: z.array(z.object({ title: z.string().max(200), horizon: z.enum(['now', 'today', 'week', 'month', 'long']), why: z.string().max(300) })).max(3).default([]),
  improvements: z.array(z.string().max(400)).max(3).default([]),
});

export interface ReflectionLog {
  id: string;
  day: string; // YYYY-MM-DD
  at: number;
  summary: string;
  stats: { runs: number; failed: number; denied: number; tools: number; costNanoUsd: number };
  lessons: string[];
  mistakes: string[];
  skillsProposed: string[];
  goalsProposed: string[];
  improvements: string[];
}

/** A proposed change to Feroxes's own prompts, tools or workflows: never applied without the owner. */
export interface ImprovementProposal {
  id: string;
  text: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
}

const REFLECT_SYSTEM = `You are the reflective part of a personal AI agent. Review the last day of the agent's own work and return JSON:
- summary: what happened, in 3–6 sentences (third person, "Feroxes").
- lessons: durable lessons about how to serve this owner better.
- mistakes: concrete mistakes to avoid repeating (failed actions, wrong assumptions, denied approvals).
- focus: what the agent should focus on next.
- skills: multi-step workflows that worked and are worth reusing (name, trigger, steps, tools).
- goal_suggestions: goals the owner might want, only if clearly supported by the day.
- improvements: changes to the agent's own instructions or tools that would help (they will be shown to the owner, not applied).
Be specific and honest. Empty lists are fine.`;

/**
 * The learning loop (intent → actions → outcome → feedback → lessons): a daily reflection that
 * updates the self-model's lessons, proposes skills and goals, and logs how the agent evolves.
 */
export class ReflectionService {
  private readonly o: { router: ModelRouter; store: AgentStore; docs: DocStore; self: SelfModelService; goals: GoalService; skills: SkillLibrary; clock: Clock };

  constructor(deps: { router: ModelRouter; store: AgentStore; docs: DocStore; self: SelfModelService; goals: GoalService; skills: SkillLibrary; clock?: Clock }) {
    this.o = { clock: systemClock, ...deps };
  }

  /** Runs, tool calls and outcomes of the last `windowMs`, as a compact journal. */
  async journal(windowMs = DAY): Promise<{ text: string; runs: Run[]; stats: ReflectionLog['stats'] }> {
    const since = this.o.clock.now() - windowMs;
    const runs = (await this.o.store.listRuns({})).filter((r) => r.createdAt >= since);
    const stats = { runs: runs.length, failed: 0, denied: 0, tools: 0, costNanoUsd: 0 };
    const lines: string[] = [];
    for (const r of runs) {
      stats.costNanoUsd += r.totals.costNanoUsd;
      if (r.status === 'failed') stats.failed++;
      const msgs = (await this.o.store.messages(r.sessionId)).filter((m) => m.runId === r.id || (m.role === 'user' && m.createdAt <= r.createdAt));
      const intent = [...msgs].reverse().find((m) => m.role === 'user' && m.createdAt <= r.createdAt)?.content ?? r.goal ?? '';
      const tools = msgs.filter((m) => m.role === 'tool');
      stats.tools += tools.length;
      const denied = tools.filter((t) => t.content.startsWith('Not done')).length;
      stats.denied += denied;
      const answer = [...msgs].reverse().find((m) => m.role === 'assistant' && m.content && m.runId === r.id)?.content ?? '';
      lines.push(`- [${r.status}] intent: "${intent.slice(0, 160)}" | actions: ${tools.map((t) => `${(t.toolName ?? '').replace('__', '.')}${t.isError ? '(error)' : ''}`).join(', ') || 'none'}${denied ? ` | ${denied} denied` : ''} | outcome: "${answer.slice(0, 160)}"${r.error ? ` | error: ${r.error}` : ''}`);
    }
    return { text: lines.join('\n'), runs, stats };
  }

  async reflect(): Promise<ReflectionLog | undefined> {
    const { text, stats } = await this.journal();
    if (stats.runs === 0) return undefined;
    const self = this.o.self.get();
    const result = await this.o.router.generate({
      route: 'brain.reflect',
      priority: 'deferrable',
      messages: [
        { role: 'system', content: REFLECT_SYSTEM },
        { role: 'user', content: `Current lessons: ${self.lessons.slice(-8).join(' | ') || 'none'}\nActive skills: ${this.o.skills.list('active').map((s) => s.name).join(', ') || 'none'}\nGoals: ${this.o.goals.list({ status: ['active'] }).map((g) => g.title).join('; ') || 'none'}\n\nJournal (${stats.runs} runs, ${stats.failed} failed, ${stats.denied} denied actions, ${formatUsd(stats.costNanoUsd)}):\n${text.slice(0, 20_000)}` },
      ],
      output: { name: 'reflection', schema: z.toJSONSchema(ReflectionSchema) as Record<string, unknown> },
      sensitivity: 'private',
      attribution: { taskType: 'brain.reflect', promptVersion: REFLECT_PROMPT_VERSION },
    });
    let parsed: z.infer<typeof ReflectionSchema>;
    try {
      const body = /\{[\s\S]*\}/.exec(result.text)?.[0] ?? result.text;
      parsed = ReflectionSchema.parse(JSON.parse(body));
    } catch (error) {
      throw new Error(`reflection output was not valid: ${errorMessage(error)}`);
    }

    this.o.self.update({ lessons: parsed.lessons, recentMistakes: parsed.mistakes, ...(parsed.focus.length ? { currentFocus: parsed.focus } : {}) }, 'agent', 'daily reflection');
    const skillsProposed = parsed.skills.map((s) => this.o.skills.propose(s, 'reflection').name);
    const goalsProposed = parsed.goal_suggestions.filter((g) => HORIZONS.includes(g.horizon)).map((g) => this.o.goals.create({ title: g.title, horizon: g.horizon, description: g.why }, 'agent').title);
    const now = this.o.clock.now();
    for (const text of parsed.improvements) this.o.docs.put('improvement', { id: uuidv7(now), text, status: 'pending', createdAt: now } satisfies ImprovementProposal);
    const log: ReflectionLog = { id: uuidv7(now), day: new Date(now).toISOString().slice(0, 10), at: now, summary: parsed.summary, stats, lessons: parsed.lessons, mistakes: parsed.mistakes, skillsProposed, goalsProposed, improvements: parsed.improvements };
    this.o.docs.put('reflection', log, now);
    return log;
  }

  logs(): ReflectionLog[] {
    return this.o.docs.list<ReflectionLog>('reflection');
  }

  improvements(): ImprovementProposal[] {
    return this.o.docs.list<ImprovementProposal>('improvement').filter((p) => p.status === 'pending');
  }

  /** "How have you grown?" — the evolution report over the last N days, built from logs. */
  evolutionReport(days = 7): string {
    const since = this.o.clock.now() - days * DAY;
    const logs = this.logs().filter((l) => l.at >= since);
    const versions = this.o.self.history().filter((v) => v.updatedAt >= since);
    if (!logs.length) return `No reflections in the last ${days} days yet.`;
    const total = logs.reduce((a, l) => ({ runs: a.runs + l.stats.runs, failed: a.failed + l.stats.failed, cost: a.cost + l.stats.costNanoUsd }), { runs: 0, failed: 0, cost: 0 });
    return [
      `Evolution report, last ${days} days: ${total.runs} runs (${total.failed} failed), ${formatUsd(total.cost)} spent, ${versions.length} self-model updates.`,
      `Lessons learned: ${[...new Set(logs.flatMap((l) => l.lessons))].slice(-8).join(' | ') || 'none'}`,
      `Skills proposed: ${[...new Set(logs.flatMap((l) => l.skillsProposed))].join(', ') || 'none'}; active now: ${this.o.skills.list('active').map((s) => s.name).join(', ') || 'none'}.`,
      `Mistakes I'm avoiding: ${[...new Set(logs.flatMap((l) => l.mistakes))].slice(-5).join(' | ') || 'none'}`,
      `Waiting for your decision: ${this.improvements().length} improvement idea(s), ${this.o.goals.list({ status: ['proposed'] }).length} goal proposal(s), ${this.o.skills.list('proposed').length} skill(s).`,
    ].join('\n');
  }
}
