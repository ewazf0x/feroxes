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
import { type AttentionMode, AttentionManager, ObservationService } from './attention.ts';
import { CausalModel, DOMAINS, type Domain, ForecastService, HypothesisService, simulate } from './foresight.ts';
import { MemoryPalace, ResearchColonies, thinkingQuality } from './mind.ts';

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
  const forecasts = new ForecastService({ docs: d.docs, clock });
  const causal = new CausalModel({ docs: d.docs, clock });
  const hypotheses = new HypothesisService({ docs: d.docs, clock });
  const observation = new ObservationService({ docs: d.docs, clock });
  d.hub?.onEvent((e) => observation.observe(e));
  const attention = new AttentionManager({ docs: d.docs, clock, timeZone: d.timeZone, deliver: (s) => d.notify({ title: s.title, body: s.body, urgency: s.urgency }) });
  const reflection = new ReflectionService({
    router: d.router,
    store: d.store,
    docs: d.docs,
    self,
    goals,
    skills,
    clock,
    sinks: {
      observeCause: (c) => causal.observe(c),
      predict: (f) => forecasts.predict({ statement: f.statement, probability: f.probability, resolveInDays: f.days, domain: f.domain, source: 'reflection' }),
    },
  });
  const colonies = new ResearchColonies({ docs: d.docs, runs: { startBackground: (g, o) => d.runtime().startBackground(g, o) }, store: d.store, router: d.router, clock });
  const palace = new MemoryPalace({ docs: d.docs, memory: d.memory.store, router: d.router, clock });

  /** Reflection with meta-cognition: the day's thinking quality, calibration and observations. */
  const reflectDeep = async () => {
    const q = await thinkingQuality(d.store, clock.now() - DAY);
    const cal = forecasts.calibration();
    const extra = [
      `Thinking quality today: ${Math.round(q.successRate * 100)}% of ${q.runs} runs succeeded, ${q.corrections} corrections by the owner, ${q.loopsCaught} loops caught, ${q.denied} denied actions, ${q.toolErrors} tool errors, ${formatUsd(q.costPerSuccessNanoUsd)} per successful run${q.gaps.length ? `; missing capabilities: ${q.gaps.map((g) => `${g.capability} ×${g.count}`).join(', ')}` : ''}.`,
      cal.resolved ? `Forecast calibration: Brier ${cal.brier} over ${cal.resolved} predictions${cal.bias ? ` (${cal.bias})` : ''}.` : '',
      observation.summary(1),
      causal.render(4),
    ].filter(Boolean).join('\n');
    return reflection.reflect(extra);
  };

  async function briefing(kind: 'morning' | 'evening' = 'morning'): Promise<string> {
    const now = clock.now();
    const upcoming = (await d.memory.store.list({ statuses: ['active'], kinds: ['commitment', 'event'] })).filter((m) => m.occurredAt && m.occurredAt >= now - DAY / 2 && m.occurredAt <= now + 2 * DAY);
    const lastReflection = reflection.logs().at(-1);
    const facts = [
      `${kind === 'morning' ? 'Morning' : 'Evening'} briefing for ${new Intl.DateTimeFormat('en-GB', { timeZone: d.timeZone, dateStyle: 'full' }).format(new Date(now))}.`,
      await situation.render(),
      goals.render(8),
      upcoming.length ? `Coming up: ${upcoming.map((m) => `${new Date(m.occurredAt!).toISOString().slice(0, 16).replace('T', ' ')} ${m.content}`).join('; ')}` : '',
      forecasts.render(),
      ((held) => (held.length ? `Held back for this briefing (not urgent): ${held.map((s) => s.title).join('; ')}` : ''))(attention.takeDigest()),
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
    attention.offer({ title: `${goal.autonomy === 'suggest' ? 'Suggestion' : 'Progress'}: ${goal.title}`, body: report.slice(0, 500), urgency: goal.autonomy === 'suggest' || run.status === 'waiting_approval' ? 'normal' : 'low', category: 'goal', relevance: 1 - (goal.priority - 1) / 5 });
    return `goal ${goal.title}: run ${runId.slice(-8)} ${run.status}`;
  }

  async function watchSituation(): Promise<string> {
    const fresh = (await situation.newAnomalies()).filter((a) => a.severity !== 'info');
    for (const a of fresh) attention.offer({ title: a.severity === 'critical' ? `⚠ ${a.message}` : a.message, body: a.suggestion ?? '', urgency: a.severity === 'critical' ? 'high' : 'normal', category: a.key.startsWith('phish') ? 'security' : a.key.startsWith('budget') ? 'money' : 'device', relevance: a.severity === 'critical' ? 1 : 0.7 });
    return `${fresh.length} new anomalies`;
  }

  const jobs: Job[] = [
    { name: 'situation.watch', every: 5 * 60_000, priority: 'none', run: watchSituation },
    { name: 'goals.pursue', every: 15 * 60_000, priority: 'routine', run: pursueGoals },
    { name: 'brain.reflect', dailyAt: '03:45', priority: 'deferrable', run: async () => (await reflectDeep())?.summary ?? 'no activity' },
    { name: 'memory.palace', dailyAt: '03:55', priority: 'deferrable', run: async () => (await palace.compress()).join(',') || 'unchanged' },
    {
      name: 'research.colonies',
      every: 10 * 60_000,
      priority: 'deferrable',
      run: async () => {
        const c = colonies.list('running')[0];
        if (!c) return 'idle';
        const next = await colonies.step(c.id);
        if (next.status === 'done') attention.offer({ title: `Research finished: ${next.question}`, body: (next.report ?? '').slice(0, 600), urgency: 'normal', category: 'goal', relevance: 0.8 });
        return `${next.question}: round ${next.round} ${next.status}`;
      },
    },
    {
      name: 'forecasts.review',
      dailyAt: '09:00',
      priority: 'none',
      run: async () => {
        const due = forecasts.due();
        if (due.length) attention.offer({ title: `${due.length} prediction(s) to check`, body: due.slice(0, 5).map((f) => `"${f.statement}" (${Math.round(f.probability * 100)}%) — did it happen?`).join('\n'), urgency: 'low', category: 'info', relevance: 0.4 });
        return `${due.length} due`;
      },
    },
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
    defineTool({
      name: 'think.simulate',
      toolset: 'brain',
      description: 'Before an important action, simulate several possible futures in parallel (optimistic, likely, pessimistic…), roll each forward, and compare them. Early-warning signals become forecasts that get checked later. Costs a few cents.',
      input: z.object({ action: z.string().min(10).max(2000), context: z.string().max(5000).optional(), horizonDays: z.number().int().min(1).max(730).default(30), scenarios: z.number().int().min(2).max(6).default(4), domain: z.enum(DOMAINS as [Domain, ...Domain[]]).optional() }),
      risk: { category: 'read', reversible: true },
      idempotent: true,
      timeoutMs: 180_000,
      async execute(i, ctx) {
        const r = await simulate(d.router, { action: i.action, ...(i.context ? { context: i.context } : {}), horizonDays: i.horizonDays, scenarios: i.scenarios, values: self.get().values, forecasts, ...(i.domain ? { domain: i.domain } : {}), runId: ctx.runId, signal: ctx.signal });
        return { content: `${r.synthesis}\n\nScenarios: ${r.scenarios.map((s) => `${s.name} ${Math.round(s.probability * 100)}% (value ${s.rollout?.value ?? '?'})`).join(' | ')}; expected value ${r.expectedValue}. Tracking ${r.forecasts.length} early signal(s) as forecasts. Cost ${formatUsd(r.costNanoUsd)}.`, data: r };
      },
    }),
    defineTool({
      name: 'forecast.make',
      toolset: 'brain',
      description: 'Write down a checkable prediction with an honest probability and a date. Your predictions are scored later, so calibrate.',
      input: z.object({ statement: z.string().min(5).max(300), probability: z.number().min(0.01).max(0.99), days: z.number().int().min(1).max(730), domain: z.enum(DOMAINS as [Domain, ...Domain[]]).default('other') }),
      risk: { category: 'internal_write', reversible: true },
      idempotent: false,
      async execute(i) {
        const f = forecasts.predict({ statement: i.statement, probability: i.probability, resolveInDays: i.days, domain: i.domain, source: 'agent' });
        return { content: `Forecast [f:${f.id.slice(-6)}] recorded: ${Math.round(f.probability * 100)}% by ${new Date(f.resolveBy).toISOString().slice(0, 10)}.` };
      },
    }),
    defineTool({
      name: 'forecast.resolve',
      toolset: 'brain',
      description: 'Record whether a prediction came true, once you know. The owner can correct it.',
      input: z.object({ id: z.string().min(4).max(40), happened: z.boolean(), note: z.string().max(300).optional() }),
      risk: { category: 'internal_write', reversible: true },
      idempotent: false,
      async execute(i) {
        const f = forecasts.resolve(i.id, i.happened, 'agent', i.note);
        const c = forecasts.calibration();
        return { content: `Resolved "${f.statement}" as ${i.happened ? 'true' : 'false'}. Record: Brier ${c.brier ?? '–'} over ${c.resolved}.` };
      },
    }),
    defineTool({
      name: 'causal.note',
      toolset: 'brain',
      description: "Record evidence about a cause-and-effect pattern in the owner's life or systems (e.g. late coffee → worse sleep). Repeated evidence raises confidence; contrary evidence lowers it.",
      input: z.object({ cause: z.string().min(3).max(200), effect: z.string().min(3).max(200), direction: z.enum(['increases', 'decreases']).default('increases'), domain: z.enum(DOMAINS as [Domain, ...Domain[]]).default('other'), supports: z.boolean().default(true), evidence: z.string().min(3).max(300) }),
      risk: { category: 'internal_write', reversible: true },
      idempotent: false,
      async execute(i) {
        const b = causal.observe(i);
        return { content: `${b.cause} → ${b.direction} → ${b.effect}: confidence now ${Math.round(b.confidence * 100)}% (${b.evidence.length} piece(s) of evidence).` };
      },
    }),
    defineTool({
      name: 'causal.explain',
      toolset: 'brain',
      description: 'Ask the causal world model what tends to cause something, or what something tends to cause, including chains across life domains.',
      input: z.object({ about: z.string().min(2).max(200) }),
      risk: { category: 'read', reversible: true },
      idempotent: true,
      async execute({ about }) {
        const causes = causal.causesOf(about);
        const effects = causal.effectsOf(about);
        const chains = causal.chains().filter((c) => c.path.some((p) => causal.causesOf(about).includes(p) || causal.effectsOf(about).includes(p)));
        if (!causes.length && !effects.length) return { content: `Nothing learned yet about "${about}".` };
        const f = (b: (typeof causes)[number]) => `${b.cause} → ${b.direction} → ${b.effect} (${Math.round(b.confidence * 100)}%)`;
        return { content: [causes.length ? `Causes: ${causes.map(f).join('; ')}` : '', effects.length ? `Effects: ${effects.map(f).join('; ')}` : '', chains.length ? `Chains: ${chains.map((c) => c.path.map((p) => p.cause).join(' → ') + ` → ${c.path.at(-1)!.effect}`).join('; ')}` : ''].filter(Boolean).join('\n') };
      },
    }),
    defineTool({
      name: 'hypotheses.track',
      toolset: 'brain',
      description: 'Keep several explanations of an unclear situation at once and update them with evidence (Bayes rule), instead of committing to the first guess. action=open needs question + hypotheses; action=update needs board, evidence and likelihoods (h1, h2… → how likely the evidence is if that hypothesis were true); action=close needs board + conclusion.',
      input: z.object({ action: z.enum(['open', 'update', 'close']), question: z.string().max(400).optional(), hypotheses: z.array(z.string().max(300)).min(2).max(6).optional(), board: z.string().max(40).optional(), evidence: z.string().max(400).optional(), likelihoods: z.record(z.string(), z.number().min(0).max(1)).optional(), conclusion: z.string().max(400).optional() }),
      risk: { category: 'internal_write', reversible: true },
      idempotent: false,
      async execute(i) {
        const show = (b: ReturnType<HypothesisService['get']>) => `[hb:${b.id.slice(-6)}] ${b.question}\n${[...b.hypotheses].sort((x, y) => y.probability - x.probability).map((h) => `${h.id} ${Math.round(h.probability * 100)}% ${h.text}`).join('\n')}`;
        if (i.action === 'open') return { content: show(hypotheses.open(i.question ?? 'What is going on?', i.hypotheses ?? [])) };
        if (!i.board) return { content: 'Which board? Give board.', isError: true };
        if (i.action === 'update') return { content: show(hypotheses.update(i.board, i.evidence ?? '', i.likelihoods ?? {})) };
        return { content: `Closed: ${hypotheses.close(i.board, i.conclusion ?? '').conclusion}` };
      },
    }),
    defineTool({
      name: 'research.start',
      toolset: 'brain',
      description: 'Start a research team (scout, analyst, skeptic, synthesizer by default) that works on a question in rounds in the background, for minutes to days, within a budget, and reports back.',
      input: z.object({ question: z.string().min(10).max(1000), roles: z.array(z.string().max(40)).max(6).optional(), rounds: z.number().int().min(1).max(12).default(4), budgetUsd: z.number().min(0.05).max(1).default(0.5) }),
      risk: { category: 'internal_write', reversible: true },
      idempotent: false,
      async execute(i) {
        const c = colonies.start(i.question, { ...(i.roles ? { roles: i.roles } : {}), maxRounds: i.rounds, budgetUsd: i.budgetUsd });
        return { content: `Research team [rc:${c.id.slice(-6)}] started: ${c.roles.join(', ')}, up to ${c.maxRounds} rounds, budget ${formatUsd(c.budgetNanoUsd)}. It runs in the background (background budget applies) and reports when done.` };
      },
    }),
    defineTool({
      name: 'research.status',
      toolset: 'brain',
      description: 'Status, notebook highlights or the final report of a research team.',
      input: z.object({ id: z.string().max(40).optional() }),
      risk: { category: 'read', reversible: true },
      idempotent: true,
      async execute({ id }) {
        const c = id ? colonies.get(id) : colonies.list().at(-1);
        if (!c) return { content: 'No research teams yet.' };
        return { content: c.report ? `Report for "${c.question}":\n${c.report}` : `"${c.question}": ${c.status}, round ${c.round}/${c.maxRounds}, ${formatUsd(c.spentNanoUsd)} spent.\n${c.notebook.slice(-4).map((n) => `[${n.role}] ${n.text.slice(0, 300)}`).join('\n')}` };
      },
    }),
    defineTool({
      name: 'attention.mode',
      toolset: 'brain',
      description: 'Change how often you may interrupt the owner: ambient (default, only what matters), focus (almost nothing), silent (observe and learn, no interruptions except security and money), proactive (more suggestions). Use when the owner asks.',
      input: z.object({ mode: z.enum(['ambient', 'focus', 'silent', 'proactive']) }),
      risk: { category: 'internal_write', reversible: true },
      idempotent: true,
      async execute({ mode }) {
        attention.setMode(mode as AttentionMode);
        return { content: `Attention mode: ${mode}.` };
      },
    }),
    defineTool({
      name: 'self.quality',
      toolset: 'brain',
      description: 'Look at the measured quality of your own thinking: success rate, corrections, loops, denied actions, cost per success, missing capabilities, forecast calibration.',
      input: z.object({ days: z.number().int().min(1).max(90).default(7) }),
      risk: { category: 'read', reversible: true },
      idempotent: true,
      async execute({ days }) {
        const q = await thinkingQuality(d.store, clock.now() - days * DAY);
        const c = forecasts.calibration();
        return { content: `Last ${days} day(s): ${q.runs} runs, ${Math.round(q.successRate * 100)}% succeeded, ${q.corrections} corrections, ${q.loopsCaught} loops caught, ${q.denied} denied, ${q.toolErrors} tool errors, ${formatUsd(q.costPerSuccessNanoUsd)} per success.${q.gaps.length ? ` Capability gaps: ${q.gaps.map((g) => `${g.capability} ×${g.count}`).join(', ')}.` : ''} Forecasts: ${c.resolved ? `Brier ${c.brier} over ${c.resolved}${c.bias ? `, ${c.bias}` : ''}` : 'none resolved yet'}.` };
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
    stableContext: async () => [self.render(), goals.render(), skills.render(), causal.render(), forecasts.render(), palace.render()].filter(Boolean),
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
        attention.currentMode !== 'ambient' ? `<owner_state>Attention mode: ${attention.currentMode}.</owner_state>` : '',
        hypotheses.render(),
        colonies.render(),
      ].filter(Boolean);
    },
    forecasts,
    causal,
    hypotheses,
    observation,
    attention,
    colonies,
    palace,
    reflectDeep,
    toolsets: ['brain'],
    horizons: HORIZONS,
  };
}

export type Brain = ReturnType<typeof createBrain>;
