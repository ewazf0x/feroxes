import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentHarness } from '@feroxes/agent';
import { createTestRouter, type MockResponse } from '@feroxes/llm';
import { InMemoryMemoryStore, MemoryService } from '@feroxes/memory';
import { DAY, ManualClock } from '@feroxes/shared';
import {
  AttentionManager,
  CausalModel,
  ForecastService,
  HypothesisService,
  InMemoryDocStore,
  MemoryPalace,
  ObservationService,
  ResearchColonies,
  type RunPort,
  exportLegacy,
  importLegacy,
  roomOf,
  simulate,
  thinkingQuality,
} from './index.ts';

const say = (text: string): MockResponse => ({ steps: [{ kind: 'text', text }] });
const clockAt = (iso: string) => new ManualClock(Date.parse(iso));

test('forecasts are scored: Brier score, buckets, and overconfidence is detected', () => {
  const clock = clockAt('2026-11-08T09:00:00Z');
  const f = new ForecastService({ docs: new InMemoryDocStore(), clock });
  // Eight 90% predictions of which only half came true: overconfident.
  for (let i = 0; i < 8; i++) f.resolve(f.predict({ statement: `thing ${i}`, probability: 0.9, resolveInDays: 3, domain: 'work', source: 'agent' }).id, i % 2 === 0, 'agent');
  const c = f.calibration();
  assert.equal(c.resolved, 8);
  assert.equal(c.brier, 0.41); // (4 × 0.01 + 4 × 0.81) / 8
  assert.equal(c.bias, 'overconfident');
  assert.equal(c.byDomain.work?.n, 8);
  const open = f.predict({ statement: 'The owner finishes the report by Friday', probability: 0.7, resolveInDays: 5, source: 'agent' });
  assert.match(f.render(), /tend to be overconfident/);
  clock.advance(6 * DAY);
  assert.deepEqual(f.due().map((x) => x.id), [open.id]);
  f.resolve(open.id, true, 'owner');
  assert.throws(() => f.resolve(open.id, false, 'agent'), /already resolved/);
});

test('causal model: evidence raises and lowers confidence; chains cross life domains', () => {
  const m = new CausalModel({ docs: new InMemoryDocStore(), clock: clockAt('2026-11-08T09:00:00Z') });
  m.observe({ cause: 'coffee after 4pm', effect: 'poor sleep', domain: 'health', supports: true, evidence: 'Tuesday: coffee 5pm, slept 5h' });
  const b = m.observe({ cause: 'late coffee after 4pm', effect: 'poor sleep quality', domain: 'health', supports: true, evidence: 'Thursday again' });
  assert.equal(b.evidence.length, 2, 'matched by meaning, not exact text');
  assert.ok(b.confidence > 0.55);
  m.observe({ cause: 'poor sleep', effect: 'missed work deadlines', domain: 'work', supports: true, evidence: 'Friday deadline slipped after a bad night' });
  m.observe({ cause: 'poor sleep', effect: 'missed work deadlines', domain: 'work', supports: true, evidence: 'again on Monday' });
  const chain = m.chains()[0];
  assert.ok(chain?.crossDomain);
  assert.equal(chain?.path.length, 2);
  assert.match(m.render(), /Connection: coffee after 4pm → poor sleep → missed work deadlines/);
  const weakened = m.observe({ cause: 'coffee after 4pm', effect: 'poor sleep', supports: false, evidence: 'Saturday: coffee at 6pm, slept well' });
  assert.ok(weakened.confidence < b.confidence);
});

test('hypotheses: several explanations updated with Bayes rule', () => {
  const h = new HypothesisService({ docs: new InMemoryDocStore() });
  const board = h.open('Why is the PC slow today?', ['A background update is running', 'The disk is almost full', 'A browser tab is using the CPU']);
  const next = h.update(board.id, 'Disk has 4 GB free', { h1: 0.3, h2: 0.9, h3: 0.3 });
  assert.deepEqual(next.hypotheses.map((x) => x.probability), [0.2, 0.6, 0.2]);
  assert.match(h.render(), /h2 60% The disk is almost full/);
  assert.equal(h.close(board.id, 'Disk was full; cleaned Downloads').status, 'closed');
});

test('simulation: parallel futures, expected value, and early signals tracked as forecasts', async () => {
  const t = createTestRouter();
  const haiku = (r: MockResponse) => t.adapter('anthropic').queue('anthropic/haiku', r);
  haiku(say(JSON.stringify({ scenarios: [{ name: 'Smooth', assumptions: 'client accepts', probability: 0.5 }, { name: 'Pushback', assumptions: 'client negotiates', probability: 0.3 }, { name: 'Lost client', assumptions: 'client leaves', probability: 0.2 }] })));
  for (const v of [6, 1, -7]) haiku(say(JSON.stringify({ day1: 'email sent', week1: 'reply', horizon: 'outcome', risks: ['churn'], reversible: v > 0, value: v, watch: [{ signal: `signal for value ${v}`, probability: 0.8, days: 7 }] })));
  t.adapter('anthropic').queue('anthropic/sonnet', say('Recommendation: raise prices by 10%, not 30%.\nAsk the owner first: yes'));
  const forecasts = new ForecastService({ docs: new InMemoryDocStore(), clock: t.clock });
  const r = await simulate(t.router, { action: 'Raise my freelance rate by 30%', values: ['Careful with money'], forecasts, domain: 'finance' });
  assert.equal(r.scenarios.length, 3);
  assert.equal(r.expectedValue, 1.9); // 0.5×6 + 0.3×1 + 0.2×(−7)
  assert.match(r.synthesis, /Ask the owner first: yes/);
  assert.equal(r.forecasts.length, 3);
  assert.equal(forecasts.list()[0]?.source, 'simulation');
  assert.equal(t.adapter('anthropic').calls.filter((c) => c.modelId === 'anthropic/haiku').length, 4, 'one generation + three rollouts on the cheap model');
});

test('attention: an interruption budget, quiet hours and silent mode, but security always gets through', () => {
  const clock = clockAt('2026-11-08T13:00:00Z');
  const delivered: string[] = [];
  const a = new AttentionManager({ docs: new InMemoryDocStore(), clock, timeZone: 'UTC', deliver: (s) => delivered.push(s.title) });
  for (let i = 0; i < 8; i++) a.offer({ title: `update ${i}`, body: '', urgency: 'normal', relevance: 0.9 });
  assert.equal(delivered.length, 6, 'ambient mode allows 6 interruptions a day');
  assert.equal(a.offer({ title: 'trivia', body: '', urgency: 'low', relevance: 0.1 }).decision, 'silent');
  a.setMode('silent');
  assert.equal(a.offer({ title: 'goal progress', body: '', urgency: 'normal' }).decision, 'digest');
  assert.equal(a.offer({ title: 'Scam SMS', body: '', urgency: 'high', category: 'security' }).decision, 'now');
  a.setMode('ambient');
  clock.set(Date.parse('2026-11-09T02:00:00Z'));
  assert.equal(a.offer({ title: 'night note', body: '', urgency: 'normal', relevance: 1 }).reason, 'quiet hours');
  const digest = a.takeDigest().map((s) => s.title);
  assert.ok(digest.includes('goal progress') && digest.includes('night note') && digest.includes('update 6'));
  assert.equal(a.takeDigest().length, 0);
});

test('silent observation learns app time and focus blocks from app switches only', () => {
  const clock = clockAt('2026-11-08T09:00:00Z');
  const o = new ObservationService({ docs: new InMemoryDocStore(), clock });
  const at = (m: number) => Date.parse('2026-11-08T09:00:00Z') + m * 60_000;
  o.observe({ event: 'foreground_changed', data: { app: 'VS Code' }, deviceName: 'PC', at: at(0) });
  o.observe({ event: 'foreground_changed', data: { app: 'Chrome' }, deviceName: 'PC', at: at(50) });
  o.observe({ event: 'foreground_changed', data: { app: 'VS Code' }, deviceName: 'PC', at: at(60) });
  o.observe({ event: 'screen_locked', data: {}, deviceName: 'PC', at: at(90) });
  const day = o.days()[0]!;
  assert.deepEqual(day.apps, { 'VS Code': 80, Chrome: 10 });
  assert.equal(day.focusBlocks.length, 2);
  assert.match(o.summary(), /VS Code 1\.3 h.*2 focus block\(s\).*longest 50 min in VS Code/);
  o.forget();
  assert.equal(o.days().length, 0);
});

test('research colony: roles work in parallel each round on a shared notebook, then report', async () => {
  const t = createTestRouter();
  const started: string[] = [];
  // Each specialist is a background agent run; here they answer from a script.
  const runs: RunPort = {
    async startBackground(goal) {
      started.push(goal);
      const run = { id: `r${started.length}`, sessionId: `s${started.length}`, status: 'completed', totals: { steps: 1, costNanoUsd: 1_000_000, inputTokens: 0, outputTokens: 0 } };
      return { runId: run.id, done: Promise.resolve(run as never) };
    },
  };
  const store = { messages: async (sessionId: string) => [{ role: 'assistant', content: `finding from ${sessionId}` }] } as never;
  const colonies = new ResearchColonies({ docs: new InMemoryDocStore(), runs, store, router: t.router, clock: t.clock });
  const c = colonies.start('Which e-bike should the owner buy under €2,000?', { maxRounds: 2, budgetUsd: 0.5 });
  await colonies.step(c.id);
  assert.equal(started.length, 4);
  assert.ok(started.some((g) => g.includes('You are the skeptic')));
  t.adapter('anthropic').queue('anthropic/sonnet', say('Answer: the X model. Findings…'));
  const done = await colonies.step(c.id);
  assert.equal(done.status, 'done');
  assert.equal(done.notebook.length, 8);
  assert.match(done.report ?? '', /Answer: the X model/);
  assert.ok(started.at(-1)!.includes('Team notebook so far'), 'round 2 sees round 1');
});

test('memory palace sorts memories into rooms and compresses changed rooms', async () => {
  const t = createTestRouter();
  const store = new InMemoryMemoryStore();
  const memory = new MemoryService({ store, clock: t.clock });
  for (const c of ["The owner's sister is Leila.", "The owner's friend Sam lives in Rome.", "The owner's mother's birthday is 3 May.", 'The owner runs on Tuesdays.']) await memory.remember({ content: c, kind: 'fact' }, 'owner');
  assert.equal(roomOf({ content: 'Rent is due on the 1st' }), 'finance');
  const palace = new MemoryPalace({ docs: new InMemoryDocStore(), memory: store, router: t.router, clock: t.clock });
  t.adapter('anthropic').queue('anthropic/haiku', say('Sister Leila; friend Sam in Rome; mother born 3 May.'));
  assert.deepEqual(await palace.compress(), ['relationships']);
  assert.deepEqual(await palace.compress(), [], 'unchanged rooms are not recompressed');
  assert.match(palace.render(), /relationships \(3\): Sister Leila/);
});

test('legacy mode: everything moves to a new machine in one encrypted file', async () => {
  const t = createTestRouter();
  const oldMem = new InMemoryMemoryStore();
  const oldDocs = new InMemoryDocStore();
  const memory = new MemoryService({ store: oldMem, clock: t.clock });
  await memory.remember({ content: "The owner's dog is Bruno.", kind: 'fact' }, 'owner');
  oldDocs.put('goal', { id: 'g1', title: 'Learn Spanish' });
  oldDocs.put('self', { id: 'self', version: 7 });
  const file = await exportLegacy({ memory: oldMem, docs: oldDocs }, 'correct horse battery staple');
  assert.ok(!file.toString('latin1').includes('Bruno'), 'encrypted, not readable');
  await assert.rejects(importLegacy({ memory: new InMemoryMemoryStore(), docs: new InMemoryDocStore() }, file, 'wrong passphrase!!'), /Wrong passphrase/);
  const newMem = new InMemoryMemoryStore();
  const newDocs = new InMemoryDocStore();
  const r = await importLegacy({ memory: newMem, docs: newDocs }, file, 'correct horse battery staple');
  assert.equal(r.memories, 1);
  assert.equal((await newMem.list({}))[0]?.content, "The owner's dog is Bruno.");
  assert.equal(newDocs.get<{ version: number }>('self', 'self')?.version, 7);
  assert.equal((await newMem.events((await newMem.list({}))[0]!.id)).length, 1, 'history moves too');
});

test('thinking quality counts corrections, loops and capability gaps', async () => {
  const h = await createAgentHarness();
  const same = { steps: [{ kind: 'tool' as const, name: 'time__now', args: { timeZone: 'UTC' } }] };
  h.t.adapter('anthropic').queue('anthropic/sonnet', same, same, same, say('Sorry.'), { steps: [{ kind: 'tool', name: 'desktop__click', args: { x: 1, y: 1 } }] }, say('I cannot click.'));
  const s = await h.runtime.createSession();
  await (await h.runtime.sendMessage(s.id, 'time?', { tier: 'balanced' })).done;
  await (await h.runtime.sendMessage(s.id, "No, that's wrong. Click the button.", { tier: 'balanced' })).done;
  const q = await thinkingQuality(h.agentStore, 0);
  assert.equal(q.runs, 2);
  assert.equal(q.corrections, 1);
  assert.equal(q.loopsCaught, 1);
  assert.equal(q.gaps[0]?.capability, 'desktop__click');
});
