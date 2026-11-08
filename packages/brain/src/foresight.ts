import type { ModelRouter } from '@feroxes/llm';
import { type Clock, DAY, FeroxesError, errorMessage, systemClock, uuidv7 } from '@feroxes/shared';
import * as z from 'zod/v4';
import type { DocStore } from './docs.ts';

// =============================================================================================
// Forecasts with calibration: the agent writes down predictions with probabilities and resolve
// dates, and they are scored when reality arrives (Brier score). Its foresight is measured, not
// assumed, and over- or under-confidence shows up per domain (meta-cognition).
// =============================================================================================

export type Domain = 'work' | 'health' | 'finance' | 'relationships' | 'projects' | 'home' | 'learning' | 'devices' | 'other';
export const DOMAINS: Domain[] = ['work', 'health', 'finance', 'relationships', 'projects', 'home', 'learning', 'devices', 'other'];

export interface Forecast {
  id: string;
  statement: string;
  probability: number; // 0..1 that the statement turns out true
  domain: Domain;
  createdAt: number;
  resolveBy: number;
  source: 'agent' | 'simulation' | 'reflection' | 'owner';
  outcome?: boolean;
  resolvedAt?: number;
  resolvedBy?: 'owner' | 'agent';
  note?: string;
}

export class ForecastService {
  private readonly docs: DocStore;
  private readonly clock: Clock;

  constructor(deps: { docs: DocStore; clock?: Clock }) {
    this.docs = deps.docs;
    this.clock = deps.clock ?? systemClock;
  }

  predict(input: { statement: string; probability: number; resolveInDays: number; domain?: Domain; source: Forecast['source'] }): Forecast {
    const now = this.clock.now();
    const f: Forecast = { id: uuidv7(now), statement: input.statement.trim(), probability: Math.min(0.99, Math.max(0.01, input.probability)), domain: input.domain ?? 'other', createdAt: now, resolveBy: now + Math.max(1, input.resolveInDays) * DAY, source: input.source };
    this.docs.put('forecast', f, now);
    return f;
  }

  resolve(id: string, outcome: boolean, by: 'owner' | 'agent', note?: string): Forecast {
    const f = this.list().find((x) => x.id === id || x.id.endsWith(id));
    if (!f) throw new FeroxesError('not_found', `No forecast ${id}.`);
    // The owner can always correct a resolution; the agent can't overwrite the owner's.
    if (f.resolvedBy === 'owner' && by === 'agent') throw new FeroxesError('owner_only', 'The owner already resolved this forecast.');
    const next: Forecast = { ...f, outcome, resolvedAt: this.clock.now(), resolvedBy: by, ...(note ? { note } : {}) };
    this.docs.put('forecast', next);
    return next;
  }

  list(): Forecast[] {
    return this.docs.list<Forecast>('forecast');
  }

  /** Open forecasts whose date has passed: time to check what happened. */
  due(now = this.clock.now()): Forecast[] {
    return this.list().filter((f) => f.outcome === undefined && f.resolveBy <= now);
  }

  upcoming(days = 14, now = this.clock.now()): Forecast[] {
    return this.list().filter((f) => f.outcome === undefined && f.resolveBy > now && f.resolveBy <= now + days * DAY).sort((a, b) => a.resolveBy - b.resolveBy);
  }

  /** Brier score (0 = perfect, 0.25 = coin flip) overall, per domain, and the bias direction. */
  calibration(): { resolved: number; brier?: number; bias?: 'overconfident' | 'underconfident' | 'calibrated'; byDomain: Partial<Record<Domain, { n: number; brier: number }>>; buckets: { range: string; n: number; predicted: number; actual: number }[] } {
    const done = this.list().filter((f) => f.outcome !== undefined);
    if (done.length === 0) return { resolved: 0, byDomain: {}, buckets: [] };
    const sq = (f: Forecast) => (f.probability - (f.outcome ? 1 : 0)) ** 2;
    const byDomain: Partial<Record<Domain, { n: number; brier: number }>> = {};
    for (const d of DOMAINS) {
      const xs = done.filter((f) => f.domain === d);
      if (xs.length) byDomain[d] = { n: xs.length, brier: round(xs.reduce((a, f) => a + sq(f), 0) / xs.length) };
    }
    const buckets = [0, 0.2, 0.4, 0.6, 0.8].map((lo) => {
      const xs = done.filter((f) => f.probability >= lo && f.probability < lo + 0.2 + (lo === 0.8 ? 0.01 : 0));
      return { range: `${Math.round(lo * 100)}–${Math.round((lo + 0.2) * 100)}%`, n: xs.length, predicted: round(avg(xs.map((f) => f.probability))), actual: round(avg(xs.map((f) => (f.outcome ? 1 : 0)))) };
    }).filter((b) => b.n > 0);
    // Confident forecasts (far from 50%) that land less often than claimed = overconfidence.
    const confident = done.filter((f) => Math.abs(f.probability - 0.5) >= 0.2);
    const claimed = avg(confident.map((f) => Math.max(f.probability, 1 - f.probability)));
    const hit = avg(confident.map((f) => ((f.probability >= 0.5) === f.outcome ? 1 : 0)));
    const bias = confident.length < 5 ? undefined : hit < claimed - 0.1 ? 'overconfident' : hit > claimed + 0.1 ? 'underconfident' : 'calibrated';
    return { resolved: done.length, brier: round(done.reduce((a, f) => a + sq(f), 0) / done.length), ...(bias ? { bias } : {}), byDomain, buckets };
  }

  render(): string {
    const c = this.calibration();
    const up = this.upcoming(14);
    if (!c.resolved && !up.length) return '';
    return [
      c.resolved ? `Your forecasting record: Brier ${c.brier} over ${c.resolved} resolved predictions${c.bias ? `; you tend to be ${c.bias}, adjust your probabilities` : ''}.` : '',
      up.length ? `Open predictions (next 14 days): ${up.slice(0, 5).map((f) => `"${f.statement}" ${Math.round(f.probability * 100)}% by ${new Date(f.resolveBy).toISOString().slice(0, 10)}`).join('; ')}` : '',
    ].filter(Boolean).join('\n');
  }
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x: number) => Math.round(x * 1000) / 1000;

// =============================================================================================
// Causal world model: beliefs of the form "cause → effect" with direction, confidence and
// evidence. Evidence moves confidence; weak beliefs retire. Chains connect domains
// ("short sleep → low focus → missed deadlines").
// =============================================================================================

export interface CausalBelief {
  id: string;
  cause: string;
  effect: string;
  direction: 'increases' | 'decreases';
  domain: Domain;
  confidence: number;
  evidence: { at: number; text: string; supports: boolean }[];
  lag?: string;
  status: 'active' | 'retired';
  createdAt: number;
  updatedAt: number;
}

const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2 && !['the', 'and', 'for', 'with', 'owner', "owner's", 'more', 'less', 'when'].includes(w)));
const overlap = (a: string, b: string) => {
  const A = words(a);
  const B = words(b);
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return A.size && B.size ? n / Math.min(A.size, B.size) : 0;
};

export class CausalModel {
  private readonly docs: DocStore;
  private readonly clock: Clock;

  constructor(deps: { docs: DocStore; clock?: Clock }) {
    this.docs = deps.docs;
    this.clock = deps.clock ?? systemClock;
  }

  /** Adds evidence to an existing belief (matched by meaning) or creates a new one. */
  observe(input: { cause: string; effect: string; direction?: CausalBelief['direction']; domain?: Domain; supports: boolean; evidence: string; lag?: string }): CausalBelief {
    const now = this.clock.now();
    const match = this.beliefs().find((b) => overlap(b.cause, input.cause) >= 0.6 && overlap(b.effect, input.effect) >= 0.6);
    if (match) {
      const confidence = input.supports ? match.confidence + (1 - match.confidence) * 0.3 : match.confidence * 0.6;
      const next: CausalBelief = { ...match, confidence: round(confidence), evidence: [...match.evidence, { at: now, text: input.evidence.slice(0, 300), supports: input.supports }].slice(-20), status: confidence < 0.15 ? 'retired' : 'active', updatedAt: now };
      this.docs.put('belief', next, now);
      return next;
    }
    const b: CausalBelief = { id: uuidv7(now), cause: input.cause.trim(), effect: input.effect.trim(), direction: input.direction ?? 'increases', domain: input.domain ?? 'other', confidence: input.supports ? 0.4 : 0.2, evidence: [{ at: now, text: input.evidence.slice(0, 300), supports: input.supports }], ...(input.lag ? { lag: input.lag } : {}), status: 'active', createdAt: now, updatedAt: now };
    this.docs.put('belief', b, now);
    return b;
  }

  beliefs(includeRetired = false): CausalBelief[] {
    return this.docs.list<CausalBelief>('belief').filter((b) => includeRetired || b.status === 'active');
  }

  effectsOf(x: string): CausalBelief[] {
    return this.beliefs().filter((b) => overlap(b.cause, x) >= 0.5).sort((a, b) => b.confidence - a.confidence);
  }

  causesOf(y: string): CausalBelief[] {
    return this.beliefs().filter((b) => overlap(b.effect, y) >= 0.5).sort((a, b) => b.confidence - a.confidence);
  }

  /** Two-step chains, preferring ones that cross domains (cross-domain pattern recognition). */
  chains(minConfidence = 0.35): { path: CausalBelief[]; confidence: number; crossDomain: boolean }[] {
    const strong = this.beliefs().filter((b) => b.confidence >= minConfidence);
    const out: { path: CausalBelief[]; confidence: number; crossDomain: boolean }[] = [];
    for (const a of strong) for (const b of strong) if (a.id !== b.id && overlap(a.effect, b.cause) >= 0.5) out.push({ path: [a, b], confidence: round(a.confidence * b.confidence), crossDomain: a.domain !== b.domain });
    return out.sort((x, y) => Number(y.crossDomain) - Number(x.crossDomain) || y.confidence - x.confidence).slice(0, 10);
  }

  render(limit = 6): string {
    const top = this.beliefs().sort((a, b) => b.confidence - a.confidence).slice(0, limit);
    if (!top.length) return '';
    const chain = this.chains()[0];
    return [`What you've learned about cause and effect in the owner's life (confidence):`, ...top.map((b) => `- ${b.cause} → ${b.direction} → ${b.effect} (${Math.round(b.confidence * 100)}%, ${b.domain})`), ...(chain ? [`Connection: ${chain.path.map((p) => p.cause).join(' → ')} → ${chain.path.at(-1)!.effect}`] : [])].join('\n');
  }
}

// =============================================================================================
// Parallel hypotheses: several explanations of "what is going on", kept at once and updated
// with evidence (Bayes rule), instead of locking onto the first guess.
// =============================================================================================

export interface HypothesisBoard {
  id: string;
  question: string;
  hypotheses: { id: string; text: string; probability: number }[];
  log: { at: number; evidence: string; likelihoods: Record<string, number> }[];
  status: 'open' | 'closed';
  conclusion?: string;
  createdAt: number;
  updatedAt: number;
}

export class HypothesisService {
  private readonly docs: DocStore;
  private readonly clock: Clock;

  constructor(deps: { docs: DocStore; clock?: Clock }) {
    this.docs = deps.docs;
    this.clock = deps.clock ?? systemClock;
  }

  open(question: string, hypotheses: string[], priors?: number[]): HypothesisBoard {
    if (hypotheses.length < 2) throw new FeroxesError('invalid', 'Keep at least two hypotheses.');
    const now = this.clock.now();
    const raw = priors && priors.length === hypotheses.length ? priors : hypotheses.map(() => 1);
    const sum = raw.reduce((a, b) => a + b, 0) || 1;
    const board: HypothesisBoard = { id: uuidv7(now), question, hypotheses: hypotheses.map((text, i) => ({ id: `h${i + 1}`, text, probability: round(raw[i]! / sum) })), log: [], status: 'open', createdAt: now, updatedAt: now };
    this.docs.put('hypothesis', board, now);
    return board;
  }

  /** P(h | e) ∝ P(e | h) · P(h). Likelihoods are 0..1 per hypothesis id; missing ones count as 0.5. */
  update(boardId: string, evidence: string, likelihoods: Record<string, number>): HypothesisBoard {
    const b = this.get(boardId);
    const posts = b.hypotheses.map((h) => h.probability * Math.min(1, Math.max(0.01, likelihoods[h.id] ?? 0.5)));
    const z = posts.reduce((a, x) => a + x, 0) || 1;
    const next: HypothesisBoard = { ...b, hypotheses: b.hypotheses.map((h, i) => ({ ...h, probability: round(posts[i]! / z) })), log: [...b.log, { at: this.clock.now(), evidence: evidence.slice(0, 300), likelihoods }].slice(-30), updatedAt: this.clock.now() };
    this.docs.put('hypothesis', next);
    return next;
  }

  close(boardId: string, conclusion: string): HypothesisBoard {
    const next = { ...this.get(boardId), status: 'closed' as const, conclusion, updatedAt: this.clock.now() };
    this.docs.put('hypothesis', next);
    return next;
  }

  get(id: string): HypothesisBoard {
    const b = this.docs.list<HypothesisBoard>('hypothesis').find((x) => x.id === id || x.id.endsWith(id));
    if (!b) throw new FeroxesError('not_found', `No hypothesis board ${id}.`);
    return b;
  }

  open_(): HypothesisBoard[] {
    return this.docs.list<HypothesisBoard>('hypothesis').filter((b) => b.status === 'open');
  }

  render(): string {
    const boards = this.open_();
    if (!boards.length) return '';
    return boards.slice(0, 3).map((b) => `Open question [hb:${b.id.slice(-6)}]: ${b.question}\n${[...b.hypotheses].sort((x, y) => y.probability - x.probability).map((h) => `  ${h.id} ${Math.round(h.probability * 100)}% ${h.text}`).join('\n')}`).join('\n');
  }
}

// =============================================================================================
// Scenario simulation: before an important action, several futures are generated and rolled
// forward in parallel on cheap models, then compared on a stronger one. Signals worth watching
// become forecasts, so the simulation itself gets scored later.
// =============================================================================================

const ScenarioList = z.object({ scenarios: z.array(z.object({ name: z.string().max(80), assumptions: z.string().max(400), probability: z.number().min(0).max(1) })).min(2).max(6) });
const Rollout = z.object({ day1: z.string().max(400), week1: z.string().max(400), horizon: z.string().max(500), risks: z.array(z.string().max(200)).max(5).default([]), reversible: z.boolean(), value: z.number().min(-10).max(10), watch: z.array(z.object({ signal: z.string().max(200), probability: z.number().min(0).max(1), days: z.number().min(1).max(365) })).max(3).default([]) });

export interface Simulation {
  action: string;
  scenarios: { name: string; assumptions: string; probability: number; rollout?: z.infer<typeof Rollout>; error?: string }[];
  expectedValue: number;
  synthesis: string;
  forecasts: Forecast[];
  costNanoUsd: number;
}

function json<T>(schema: z.ZodType<T>, text: string): T {
  const body = /\{[\s\S]*\}/.exec(text)?.[0] ?? text;
  return schema.parse(JSON.parse(body));
}

export async function simulate(router: ModelRouter, input: { action: string; context?: string; horizonDays?: number; scenarios?: number; values: string[]; forecasts?: ForecastService; domain?: Domain; runId?: string; signal?: AbortSignal }): Promise<Simulation> {
  const horizon = input.horizonDays ?? 30;
  const attribution = { taskType: 'think.simulate', ...(input.runId ? { runId: input.runId } : {}) };
  const sig = input.signal ? { signal: input.signal } : {};
  let cost = 0;
  const brief = `Action under consideration: ${input.action}\nHorizon: ${horizon} days${input.context ? `\nContext:\n${input.context.slice(0, 5000)}` : ''}`;

  const gen = await router.generate({ route: 'think.perspective', messages: [{ role: 'system', content: `List ${input.scenarios ?? 4} genuinely different ways the future could unfold if the owner takes this action (include an optimistic, a likely and a pessimistic one). JSON: {"scenarios":[{"name","assumptions","probability"}]} with probabilities summing to about 1.` }, { role: 'user', content: brief }], sensitivity: 'private', attribution, ...sig });
  cost += gen.finish.costNanoUsd;
  const list = json(ScenarioList, gen.text).scenarios;
  const total = list.reduce((a, s) => a + s.probability, 0) || 1;

  const scenarios: Simulation['scenarios'] = await Promise.all(list.map(async (s): Promise<Simulation['scenarios'][number]> => {
    try {
      const r = await router.generate({ route: 'think.perspective', messages: [{ role: 'system', content: 'Simulate this scenario forward honestly. JSON: {"day1","week1","horizon","risks":[],"reversible":bool,"value":-10..10 for the owner,"watch":[{"signal","probability","days"}]} where watch lists early signals that would show this scenario is happening.' }, { role: 'user', content: `${brief}\nScenario: ${s.name}. Assumptions: ${s.assumptions}` }], sensitivity: 'private', attribution, ...sig });
      cost += r.finish.costNanoUsd;
      return { ...s, probability: round(s.probability / total), rollout: json(Rollout, r.text) };
    } catch (error) {
      return { ...s, probability: round(s.probability / total), error: errorMessage(error) };
    }
  }));
  const expectedValue = round(scenarios.reduce((a, s) => a + s.probability * (s.rollout?.value ?? 0), 0));

  const synth = await router.generate({
    route: 'think.synthesis',
    messages: [
      { role: 'system', content: `Compare the simulated futures for a personal AI agent's owner. Reply with headings:\nRecommendation:\nWhy (expected value ${expectedValue} on a -10..10 scale; weigh irreversible downside more than upside):\nEarly-warning signals:\nAlignment with the owner's values:\nAsk the owner first: yes/no\nOwner's values:\n${input.values.map((v) => `- ${v}`).join('\n')}` },
      { role: 'user', content: `${brief}\n\n${scenarios.map((s) => `## ${s.name} (${Math.round(s.probability * 100)}%)\n${s.rollout ? `day 1: ${s.rollout.day1}\nweek 1: ${s.rollout.week1}\nat horizon: ${s.rollout.horizon}\nrisks: ${s.rollout.risks.join('; ')}\nreversible: ${s.rollout.reversible}\nvalue: ${s.rollout.value}` : `(failed: ${s.error})`}`).join('\n\n')}` },
    ],
    sensitivity: 'private',
    attribution,
    ...sig,
  });
  cost += synth.finish.costNanoUsd;

  const forecasts = input.forecasts
    ? scenarios.flatMap((s) => (s.rollout?.watch ?? []).slice(0, 1).map((w) => input.forecasts!.predict({ statement: w.signal, probability: w.probability * s.probability + (1 - s.probability) * 0.1, resolveInDays: w.days, source: 'simulation', ...(input.domain ? { domain: input.domain } : {}) }))).slice(0, 3)
    : [];
  return { action: input.action, scenarios, expectedValue, synthesis: synth.text.trim(), forecasts, costNanoUsd: cost };
}
