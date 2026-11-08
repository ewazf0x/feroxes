import type { AgentRuntime, AgentStore } from '@feroxes/agent';
import type { DeviceHub } from '@feroxes/devices';
import type { ModelRouter } from '@feroxes/llm';
import type { MemoryService } from '@feroxes/memory';
import type { BudgetGate } from '@feroxes/metering';
import type { ApprovalService, AuditLog, SystemControl } from '@feroxes/policy';
import { type Clock, DAY, type Logger, errorMessage, formatUsd, localParts, noopLogger, systemClock } from '@feroxes/shared';
import { type AnyTool, defineTool, z } from '@feroxes/tools';
import { deliberate } from './deliberate.ts';
import type { DocStore } from './docs.ts';
import { explainRun } from './explain.ts';
import { GoalService, HORIZONS, SkillLibrary } from './goals.ts';
import { ReflectionService } from './reflection.ts';
import { type Job, Scheduler } from './scheduler.ts';
import { SelfModelService } from './self-model.ts';
import { type Sensor, SituationService, ThreatSensor, activityPattern, deviceSensor, ownerState } from './situation.ts';

export interface BrainDeps {
  docs: DocStore;
  router: ModelRouter;
  store: AgentStore;
  memory: MemoryService;
  audit: AuditLog;
  approvals: ApprovalService;
  system: SystemControl;
  budget?: BudgetGate;
  hub?: DeviceHub;
  runtime: () => AgentRuntime;
  notify: (n: { title: string; body: string; urgency: 'low' | 'normal' | 'high' }) => void;
  speak?: (text: string) => Promise<void>;
  clock?: Clock;
  timeZone: string;
  ownerName?: string;
  logger?: Logger;
  extraSensors?: Sensor[];
}

/**
 * The brain layer on top of the agent: continuity (self-model), initiative (goals, pursuit,
 * briefings), awareness (situation, threats, owner state), learning (journal, reflection, skills)
 * and judgment (deliberation, explanations). Every capability works through the same policy gate,
 * budgets and audit log as everything else.
 */
export function createBrain(d: BrainDeps) {
  const clock = d.clock ?? systemClock;
  const logger = d.logger ?? noopLogger;
  const self = new SelfModelService({ docs: d.docs, clock, ...(d.ownerName ? { ownerName: d.ownerName } : {}) });
  const goals = new GoalService({ docs: d.docs, clock });
  const skills = new SkillLibrary({ docs: d.docs, clock });
  const threats = new ThreatSensor();
  d.hub?.onEvent((e) => threats.observe(e));
  const sensors: Sensor[] = [...(d.hub ? [deviceSensor(() => d.hub!.devices())] : []), threats, ...(d.extraSensors ?? [])];
  if (d.budget) {
    const budget = d.budget;
    sensors.push({
      name: 'budget',
      async read() {
        const status = await budget.status();
        const day = status.find((s) => s.budget.period === 'day' && s.budget.scope.type === 'global');
        return {
          facts: day ? [`AI spend today: ${formatUsd(day.counter.spent)} of ${formatUsd(day.budget.limit)} (${day.percent.toFixed(0)}%)`] : [],
          anomalies: status.filter((s) => s.percent >= 80).map((s) => ({ key: `budget:${s.budget.id}:${s.periodStart}`, severity: s.percent >= 95 ? 'critical' : 'warning', message: `Budget "${s.budget.name}" at ${s.percent.toFixed(0)}%` }) as const),
        };
      },
    });
  }
  sensors.push({
    name: 'approvals',
    async read() {
      const pending = await d.approvals.pending();
      return { facts: pending.length ? [`${pending.length} action(s) waiting for the owner's approval: ${pending.map((p) => p.preview.title).slice(0, 3).join('; ')}`] : [], anomalies: [] };
    },
  });
  const situation = new SituationService({ sensors, clock });
  const reflection = new ReflectionService({ router: d.router, store: d.store, docs: d.docs, self, goals, skills, clock });

  async function briefing(kind: 'morning' | 'evening' = 'morning'): Promise<string> {
    const now = clock.now();
    const upcoming = (await d.memory.store.list({ statuses: ['active'], kinds: ['commitment', 'event'] })).filter((m) => m.occurredAt && m.occurredAt >= now - DAY / 2 && m.occurredAt <= now + 2 * DAY);
    const lastReflection = reflection.logs().at(-1);
    const facts = [
      `${kind === 'morning' ? 'Morning' : 'Evening'} briefing for ${new Intl.DateTimeFormat('en-GB', { timeZone: d.timeZone, dateStyle: 'full' }).format(new Date(now))}.`,
      await situation.render(),
      goals.render(8),
      upcoming.length ? `Coming up: ${upcoming.map((m) => `${new Date(m.occurredAt!).toISOString().slice(0, 16).replace('T', ' ')} ${m.content}`).join('; ')}` : '',
      lastReflection ? `Yesterday: ${lastReflection.summary}` : '',
    ].filter(Boolean).join('\n\n');
    try {
      const r = await d.router.generate({
        route: 'brain.briefing',
        messages: [{ role: 'system', content: `Write the owner's ${kind} briefing as their personal assistant: warm, specific, under 150 words. Start with the most important thing. Mention device or security problems and approvals waiting. End with one suggestion for the day.` }, { role: 'user', content: facts }],
        sensitivity: 'private',
        attribution: { taskType: 'brain.briefing' },
      });
      return r.text.trim();
    } catch (error) {
      logger.warn('briefing model call failed; using the plain version', { error: errorMessage(error) });
      return facts.replace(/<\/?situation[^>]*>/g, '');
    }
  }

  async function pursueGoals(): Promise<string> {
    const due = goals.due();
    for (const g of due) if (g.autonomy === 'inform') goals.progress(g.id, g.progress, 'checked (inform only)', 'agent');
    const goal = due.find((g) => g.autonomy !== 'inform');
    if (!goal) return 'nothing due';
    const prompt = `Background work on the owner's goal "${goal.title}" (horizon ${goal.horizon}, progress ${Math.round(goal.progress * 100)}%${goal.successCriteria ? `, done when: ${goal.successCriteria}` : ''}).
${goal.notes.length ? `Recent notes: ${goal.notes.slice(-3).map((n) => n.text).join(' | ')}` : ''}
${goal.autonomy === 'suggest' ? 'Do not take actions. Work out the best next step and propose it in two or three sentences.' : 'Take the next useful step within your permissions. Anything outward needs the owner\'s approval. Then report in two or three sentences.'}
Finish with goals.progress for goal ${goal.id.slice(-6)}.`;
    const { runId, done } = await d.runtime().startBackground(prompt, { priority: 'routine', trigger: 'schedule' });
    const run = await done;
    const msgs = await d.store.messages(run.sessionId);
    const report = [...msgs].reverse().find((m) => m.role === 'assistant' && m.content)?.content ?? run.status;
    goals.progress(goal.id, goals.get(goal.id)!.progress, `[${run.status}] ${report}`, 'agent');
    d.notify({ title: `${goal.autonomy === 'suggest' ? 'Suggestion' : 'Progress'}: ${goal.title}`, body: report.slice(0, 500), urgency: run.status === 'waiting_approval' ? 'normal' : 'low' });
    return `goal ${goal.title}: run ${runId.slice(-8)} ${run.status}`;
  }

  async function watchSituation(): Promise<string> {
    const fresh = (await situation.newAnomalies()).filter((a) => a.severity !== 'info');
    for (const a of fresh) d.notify({ title: a.severity === 'critical' ? `⚠ ${a.message}` : a.message, body: a.suggestion ?? '', urgency: a.severity === 'critical' ? 'high' : 'normal' });
    return `${fresh.length} new anomalies`;
  }

  const jobs: Job[] = [
    { name: 'situation.watch', every: 5 * 60_000, priority: 'none', run: watchSituation },
    { name: 'goals.pursue', every: 15 * 60_000, priority: 'routine', run: pursueGoals },
    { name: 'brain.reflect', dailyAt: '03:45', priority: 'deferrable', run: async () => (await reflection.reflect())?.summary ?? 'no activity' },
    {
      name: 'brain.morning_briefing',
      dailyAt: '07:30',
      priority: 'important',
      run: async () => {
        const text = await briefing('morning');
        d.docs.put('briefing', { id: new Date(clock.now()).toISOString().slice(0, 10), text });
        d.notify({ title: 'Good morning', body: text, urgency: 'normal' });
        await d.speak?.(text).catch(() => {});
        return text.slice(0, 120);
      },
    },
  ];
  const scheduler = new Scheduler({ jobs, docs: d.docs, system: d.system, ...(d.budget ? { budget: d.budget } : {}), clock, timeZone: d.timeZone, logger });

  // ---------------- tools ----------------
  const tools: AnyTool[] = [
    defineTool({
      name: 'goals.list',
      toolset: 'brain',
      description: "List the owner's goals with ids, horizons, progress and notes.",
      input: z.object({ includeDone: z.boolean().default(false) }),
      risk: { category: 'read', reversible: true },
      idempotent: true,
      async execute({ includeDone }) {
        const list = goals.list(includeDone ? {} : { status: ['active', 'proposed', 'paused'] });
        return { content: list.length ? list.map((g) => `[g:${g.id.slice(-6)}] ${g.status} ${g.horizon} P${g.priority} ${Math.round(g.progress * 100)}% ${g.title}${g.notes.length ? ` — last note: ${g.notes.at(-1)!.text.slice(0, 120)}` : ''}`).join('\n') : 'No goals yet.' };
      },
    }),
    defineTool({
      name: 'goals.propose',
      toolset: 'brain',
      description: 'Propose a goal or sub-goal for the owner to accept. You cannot activate goals yourself.',
      input: z.object({ title: z.string().min(3).max(200), horizon: z.enum(['now', 'today', 'week', 'month', 'long']), why: z.string().max(500), parentId: z.string().max(40).optional() }),
      risk: { category: 'internal_write', reversible: true },
      idempotent: false,
      async execute({ title, horizon, why, parentId }) {
        const parent = parentId ? goals.get(parentId) : undefined;
        const g = goals.create({ title, horizon, description: why, ...(parent ? { parentId: parent.id } : {}) }, 'agent');
        return { content: `Proposed goal [g:${g.id.slice(-6)}] "${g.title}". The owner decides whether to accept it.` };
      },
    }),
    defineTool({
      name: 'goals.progress',
      toolset: 'brain',
      description: 'Record progress on an active goal (0–1) with a short note.',
      input: z.object({ id: z.string().min(4).max(40), progress: z.number().min(0).max(1), note: z.string().min(2).max(1000) }),
      risk: { category: 'internal_write', reversible: true },
      idempotent: false,
      async execute({ id, progress, note }) {
        const g = goals.get(id);
        if (!g) return { content: `No goal ${id}.`, isError: true };
        goals.progress(g.id, progress, note, 'agent');
        return { content: `Updated "${g.title}" to ${Math.round(progress * 100)}%.` };
      },
    }),
    defineTool({
      name: 'self.note',
      toolset: 'brain',
      description: 'Update your self-model: a lesson learned, a mistake to avoid, or your current focus. Values, personality and boundaries can only be proposed.',
      input: z.object({ kind: z.enum(['lesson', 'mistake', 'focus', 'propose_value_change']), text: z.string().min(3).max(300) }),
      risk: { category: 'internal_write', reversible: true },
      idempotent: false,
      async execute({ kind, text }) {
        if (kind === 'propose_value_change') {
          const r = self.update({ values: [...self.get().values, text] }, 'agent', 'agent proposal');
          return { content: r.proposal ? 'Proposed to the owner; values change only with their approval.' : 'Updated.' };
        }
        self.update(kind === 'lesson' ? { lessons: [text] } : kind === 'mistake' ? { recentMistakes: [text] } : { currentFocus: [text, ...self.get().currentFocus].slice(0, 5) }, 'agent', `self.note ${kind}`);
        return { content: 'Self-model updated.' };
      },
    }),
    defineTool({
      name: 'think.deliberate',
      toolset: 'brain',
      description: 'Internal debate before an important or irreversible decision: Strategist, Critic, Safety Officer, Optimizer and Creative argue, then a synthesis predicts outcomes and checks the owner\'s values. Costs a few cents; use only when stakes justify it.',
      input: z.object({ question: z.string().min(10).max(2000), options: z.array(z.string().max(500)).max(6).default([]), context: z.string().max(6000).optional() }),
      risk: { category: 'read', reversible: true },
      idempotent: true,
      timeoutMs: 120_000,
      async execute({ question, options, context }, ctx) {
        const r = await deliberate(d.router, { question, options, ...(context ? { context } : {}), values: self.get().values, runId: ctx.runId, signal: ctx.signal });
        return { content: `${r.synthesis}\n\n(views: ${r.views.map((v) => `${v.perspective}: ${v.text.slice(0, 160)}`).join(' | ')}; cost ${formatUsd(r.costNanoUsd)})`, data: r };
      },
    }),
    defineTool({
      name: 'why.explain',
      toolset: 'brain',
      description: 'Explain exactly why and how you did something: the request, memories used, your reasoning before each action, policy decisions and the outcome. Without runId, explains your previous task in this conversation.',
      input: z.object({ runId: z.string().max(40).optional() }),
      risk: { category: 'read', reversible: true },
      idempotent: true,
      async execute({ runId }, ctx) {
        let id = runId;
        if (!id) {
          const current = await d.store.getRun(ctx.runId);
          const runs = current ? (await d.store.listRuns({ sessionId: current.sessionId })).filter((r) => r.id !== ctx.runId) : [];
          id = runs.at(-1)?.id;
        } else if (id.length < 30) {
          id = (await d.store.listRuns({})).find((r) => r.id.endsWith(id!))?.id ?? id;
        }
        if (!id) return { content: 'There is no earlier task in this conversation to explain.' };
        return { content: await explainRun({ store: d.store, audit: d.audit, memory: d.memory.store }, id) };
      },
    }),
    defineTool({
      name: 'agents.delegate',
      toolset: 'brain',
      description: 'Hand a self-contained sub-task to a temporary specialist sub-agent (researcher, writer, analyst, device operator) and get its result. It uses the same tools and permissions as you, with a smaller budget.',
      input: z.object({ role: z.enum(['researcher', 'writer', 'analyst', 'device_operator', 'planner']), task: z.string().min(10).max(4000) }),
      risk: { category: 'internal_write', reversible: true },
      idempotent: false,
      timeoutMs: 600_000,
      async execute({ role, task }, ctx) {
        const { runId, done } = await d.runtime().startBackground(`You are a temporary ${role.replace('_', ' ')} sub-agent working for Feroxes on one task. Do only this task, then answer with the result.\n\nTask: ${task}`, { priority: 'important', trigger: 'subrun' });
        ctx.progress(`sub-agent ${runId.slice(-8)} started`);
        const run = await done;
        const msgs = await d.store.messages(run.sessionId);
        const answer = [...msgs].reverse().find((m) => m.role === 'assistant' && m.content)?.content ?? '';
        return { content: `Sub-agent (${role}) finished with status ${run.status}, cost ${formatUsd(run.totals.costNanoUsd)}:\n${answer}`, isError: run.status === 'failed' };
      },
    }),
    defineTool({
      name: 'briefing.now',
      toolset: 'brain',
      description: 'Produce a briefing now: situation, devices, goals, what is coming up, approvals waiting.',
      input: z.object({ kind: z.enum(['morning', 'evening']).default('morning') }),
      risk: { category: 'read', reversible: true },
      idempotent: true,
      async execute({ kind }) {
        return { content: await briefing(kind) };
      },
    }),
  ].map((t) => t as unknown as AnyTool);

  return {
    self,
    goals,
    skills,
    situation,
    threats,
    reflection,
    scheduler,
    tools,
    briefing,
    pursueGoals,
    watchSituation,
    /** Rarely-changing context: goes into the cached system prompt. */
    stableContext: async () => [self.render(), goals.render(), skills.render()].filter(Boolean),
    /** Per-turn context: situation and owner state, sent with the latest message. */
    turnContext: async (_query: string, sessionId: string) => {
      const recent = await d.store.messages(sessionId);
      const state = ownerState(recent, clock.now(), d.timeZone);
      const pattern = activityPattern((await d.store.listRuns({})).length > 0 ? recent : [], d.timeZone);
      const hour = localParts(clock.now(), d.timeZone).hour;
      return [
        await situation.render(),
        state.guidance ? `<owner_state>${state.guidance}</owner_state>` : '',
        pattern.quietHours.includes(hour) ? '<owner_state>This is usually a quiet hour for the owner.</owner_state>' : '',
      ].filter(Boolean);
    },
    toolsets: ['brain'],
    horizons: HORIZONS,
  };
}

export type Brain = ReturnType<typeof createBrain>;
