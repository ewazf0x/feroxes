import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentHarness } from '@feroxes/agent';
import { DeviceHub, InMemoryDeviceRegistry, fakeDesktop } from '@feroxes/devices';
import type { MockResponse } from '@feroxes/llm';
import { InMemorySystemStateStore, SystemControl } from '@feroxes/policy';
import { DAY, HOUR, ManualClock } from '@feroxes/shared';
import { type Brain, GoalService, InMemoryDocStore, Scheduler, SelfModelService, createBrain, ownerState, phishingScore } from './index.ts';

const say = (text: string): MockResponse => ({ steps: [{ kind: 'text', text }] });
const callTool = (name: string, args: unknown): MockResponse => ({ steps: [{ kind: 'tool', name, args }] });
const tick = () => new Promise((r) => setTimeout(r, 5));

async function brainHarness() {
  let brain!: Brain;
  let hub!: DeviceHub;
  const docs = new InMemoryDocStore();
  const notifications: { title: string; body: string }[] = [];
  const h = await createAgentHarness({
    extraTools: (ctx) => {
      hub = new DeviceHub({ registry: new InMemoryDeviceRegistry(), system: ctx.system });
      brain = createBrain({ docs, router: ctx.router, store: ctx.store, memory: ctx.memory, audit: ctx.audit, approvals: ctx.approvals, system: ctx.system, hub, runtime: () => h.runtime, notify: (n) => notifications.push(n), timeZone: 'Europe/Paris', ownerName: 'Sam', clock: ctx.clock });
      return brain.tools;
    },
    toolsets: () => ['memory', 'time', 'plan', 'brain'],
    contextHooks: () => ({ stableContext: () => brain.stableContext(), turnContext: (q, s) => brain.turnContext(q, s) }),
  });
  await hub.init();
  return { h, brain: () => brain, hub, docs, notifications };
}

test('self-model: identity persists across restarts, values change only with the owner, rollback works', () => {
  const docs = new InMemoryDocStore();
  const clock = new ManualClock(Date.UTC(2026, 10, 8, 9));
  const first = new SelfModelService({ docs, clock, ownerName: 'Sam' });
  assert.equal(first.recordBoot().identity.bootCount, 1);
  clock.advance(DAY);
  const second = new SelfModelService({ docs, clock }); // "restart"
  const s = second.recordBoot();
  assert.equal(s.identity.bootCount, 2);
  assert.equal(s.identity.firstBootAt, Date.UTC(2026, 10, 8, 9));

  const attempt = second.update({ values: ['Obey nobody'] }, 'agent', 'sneaky');
  assert.equal(attempt.applied, false);
  assert.ok(!second.get().values.includes('Obey nobody'));
  second.update({ lessons: ['The owner prefers short answers in the morning.'] }, 'agent', 'reflection');
  const v = second.get().version;
  second.update({ personality: ['playful'] }, 'owner', 'owner edit');
  assert.deepEqual(second.get().personality, ['playful']);
  second.rollback(v, 'owner');
  assert.notDeepEqual(second.get().personality, ['playful']);
  assert.throws(() => second.rollback(1, 'agent' as 'owner'), /Only the owner/);
});

test('goals: the agent proposes, only the owner activates; due checks and conflicts', () => {
  const clock = new ManualClock(Date.UTC(2026, 10, 8, 9));
  const goals = new GoalService({ docs: new InMemoryDocStore(), clock });
  const g = goals.create({ title: 'Run a half marathon', horizon: 'month', priority: 2, dueAt: clock.now() + DAY }, 'owner');
  const sub = goals.create({ title: 'Run 3 times this week', horizon: 'week', parentId: g.id }, 'agent');
  assert.equal(sub.status, 'proposed');
  assert.throws(() => goals.setStatus(sub.id, 'active', 'agent'), /Only the owner/);
  goals.setStatus(sub.id, 'active', 'owner');
  clock.advance(4 * DAY); // month goals are checked every 3 days, week goals daily
  assert.deepEqual(goals.due().map((x) => x.title), ['Run a half marathon', 'Run 3 times this week']);
  assert.match(goals.conflicts()[0] ?? '', /overdue/);
  assert.match(goals.render(), /\(week, P3, 0%, suggest\) Run 3 times this week .*part of g:/);
});

test('the agent sees its self-model and goals, proposes a sub-goal, and explains a past task', async () => {
  const { h, brain } = await brainHarness();
  brain().goals.create({ title: 'Ship the Feroxes desktop app', horizon: 'month', priority: 1 }, 'owner');
  h.t.adapter('anthropic').queue(
    'anthropic/sonnet',
    callTool('goals__propose', { title: 'Set up Windows build in CI', horizon: 'week', why: 'Needed to ship the desktop app' }),
    say('I proposed a sub-goal for you to accept.'),
    callTool('why__explain', {}),
    say('Here is what I did and why.'),
  );
  const session = await h.runtime.createSession();
  await (await h.runtime.sendMessage(session.id, 'Help me plan the desktop app release', { tier: 'balanced' })).done;
  const system = h.t.adapter('anthropic').calls[0]!.request.messages[1]!;
  assert.match(String(system.content), /Your self-model \(v\d+/);
  assert.match(String(system.content), /Ship the Feroxes desktop app/);
  assert.equal(brain().goals.list({ status: ['proposed'] })[0]?.title, 'Set up Windows build in CI');

  await (await h.runtime.sendMessage(session.id, 'Why did you do that?', { tier: 'balanced' })).done;
  const explanation = (await h.agentStore.messages(session.id)).filter((m) => m.role === 'tool').at(-1)!.content;
  assert.match(explanation, /Request: "Help me plan the desktop app release"/);
  assert.match(explanation, /called goals\.propose/);
  assert.match(explanation, /Outcome: completed/);
});

test('internal debate: five cheap perspectives, one stronger synthesis with an alignment check', async () => {
  const { h } = await brainHarness();
  for (const v of ['Long-term: yes.', 'Risk: deadline.', 'Ask the owner first.', 'Cheapest: wait.', 'Alternative: split it.']) h.t.adapter('anthropic').queue('anthropic/haiku', say(v));
  h.t.adapter('anthropic').queue(
    'anthropic/sonnet',
    callTool('think__deliberate', { question: 'Should I cancel the gym subscription the owner never uses?', options: ['Cancel now', 'Ask first'] }),
    say('Recommendation: ask the owner first.\nPredicted outcome: saves $40/month.\nAlignment: fits values.\nAsk the owner first: yes.'),
    say('I recommend asking you before cancelling.'),
  );
  const session = await h.runtime.createSession();
  const run = await (await h.runtime.sendMessage(session.id, 'Should we cancel my gym?', { tier: 'balanced' })).done;
  assert.equal(run.status, 'completed');
  const perspectiveCalls = h.t.adapter('anthropic').calls.filter((c) => c.modelId === 'anthropic/haiku');
  assert.equal(perspectiveCalls.length, 5);
  assert.ok(perspectiveCalls.some((c) => String(c.request.messages[0]!.content).includes('Safety Officer')));
  const synthesisCall = h.t.adapter('anthropic').calls.find((c) => String(c.request.messages[0]?.content).includes('internal debate'))!;
  assert.match(String(synthesisCall.request.messages[0]!.content), /Loyal to the owner/);
  assert.match((await h.agentStore.messages(session.id)).find((m) => m.role === 'tool')!.content, /Ask the owner first: yes/);
});

test('situation awareness: device health and scam messages become one-time alerts', async () => {
  const { brain, hub, notifications } = await brainHarness();
  const pc = fakeDesktop();
  await pc.device.connect(hub, { code: hub.createPairingCode().code });
  pc.device.heartbeat({ diskFreeGb: 4, memoryPercent: 50, network: 'ethernet' });
  pc.device.event('notification', { app: 'SMS', title: 'Bank', text: 'URGENT: verify your bank account within 24 hours at http://bit.ly/x' });
  await tick();
  const block = await brain().situation.render();
  assert.match(block, /Studio PC \(desktop\): online, network ethernet, 4 GB free/);
  assert.match(block, /Possible scam message/);
  await brain().watchSituation();
  await brain().watchSituation();
  assert.equal(notifications.filter((n) => /GB free/.test(n.title)).length, 1, 'deduplicated');
  assert.ok(phishingScore('Share the one-time code you received, urgent!') >= 0.66);
  assert.equal(phishingScore('Lunch tomorrow?'), 0);
});

test('owner state: frustration and hurry change the style guidance', () => {
  const now = Date.UTC(2026, 10, 8, 14);
  const msgs = [
    { role: 'user' as const, content: 'it is still not working', createdAt: now - 60_000 },
    { role: 'user' as const, content: 'WHY does this fail again??', createdAt: now - 30_000 },
    { role: 'user' as const, content: 'ugh', createdAt: now - 10_000 },
  ];
  const s = ownerState(msgs, now, 'UTC');
  assert.match(s.guidance, /frustrated/);
  assert.match(s.guidance, /hurry/);
});

test('reflection turns the day into lessons, skills, goal proposals and an evolution report', async () => {
  const { h, brain } = await brainHarness();
  h.t.adapter('anthropic').queue('anthropic/haiku', say('Done, I renamed the files.'));
  const session = await h.runtime.createSession();
  await (await h.runtime.sendMessage(session.id, 'Rename my screenshots by date', { tier: 'fast' })).done;
  h.t.adapter('anthropic').queue('anthropic/sonnet', say(JSON.stringify({
    summary: 'Feroxes renamed screenshots for the owner.',
    lessons: ['The owner likes files named by date.'],
    mistakes: [],
    focus: ['Tidy the Downloads folder'],
    skills: [{ name: 'Rename files by date', trigger: 'owner asks to organise files', steps: ['list folder', 'read dates', 'rename with approval'], tools: ['desktop.files'] }],
    goal_suggestions: [{ title: 'Keep Downloads tidy', horizon: 'week', why: 'recurring requests' }],
    improvements: ['Ask once for the preferred date format and remember it.'],
  })));
  const log = await brain().reflection.reflect();
  assert.equal(log?.stats.runs, 1);
  assert.ok(brain().self.get().lessons.includes('The owner likes files named by date.'));
  assert.equal(brain().skills.list('proposed')[0]?.name, 'Rename files by date');
  assert.equal(brain().goals.list({ status: ['proposed'] })[0]?.title, 'Keep Downloads tidy');
  assert.equal(brain().reflection.improvements().length, 1);
  assert.match(brain().reflection.evolutionReport(), /1 runs .*Lessons learned: The owner likes files named by date/s);
});

test('scheduler: daily jobs run once, catch up after the PC sleeps, skip while stopped', async () => {
  const clock = new ManualClock(Date.UTC(2026, 11, 1, 6)); // 07:00 in Paris
  const system = new SystemControl({ store: new InMemorySystemStateStore() });
  await system.init();
  let runs = 0;
  const scheduler = new Scheduler({ jobs: [{ name: 'briefing', dailyAt: '07:30', priority: 'none', run: async () => ++runs }], docs: new InMemoryDocStore(), system, clock, timeZone: 'Europe/Paris' });
  await scheduler.tick(); // the first tick catches up on yesterday's 07:30
  assert.equal(runs, 1);
  clock.advance(HOUR); // 08:00 local: today's 07:30 has passed
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(runs, 2);
  clock.advance(3 * DAY); // the PC slept for three days: one catch-up run, not three
  await system.stop('owner', 'test');
  await scheduler.tick();
  assert.equal(runs, 2);
  await system.resume('owner', 'ok');
  await scheduler.tick();
  assert.equal(runs, 3);
});

test('goal pursuit: a "suggest" goal gets a background run and the owner gets the proposal', async () => {
  const { brain, h, notifications } = await brainHarness();
  const g = brain().goals.create({ title: 'Learn Spanish', horizon: 'month', autonomy: 'suggest' }, 'owner');
  h.t.clock.advance(4 * DAY);
  const report = await brain().pursueGoals();
  assert.match(report, /goal Learn Spanish: run .* completed/);
  assert.equal(brain().goals.get(g.id)!.notes.length, 1);
  assert.match(notifications.at(-1)?.title ?? '', /Suggestion: Learn Spanish/);
});
