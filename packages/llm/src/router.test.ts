import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Budget } from '@feroxes/metering';
import { usd } from '@feroxes/shared';
import {
  AllCandidatesFailedError,
  BudgetApprovalNeededError,
  DeferredError,
  type LlmRequest,
  NoCandidatesError,
  ProviderError,
  type RouterEvent,
  classifyComplexity,
  createTestRouter,
} from './index.ts';

const ask = (text: string, extra: Partial<LlmRequest> = {}): LlmRequest => ({
  route: 'chat.turn',
  tier: 'balanced',
  messages: [{ role: 'user', content: text }],
  sensitivity: 'normal',
  attribution: { taskType: 'chat' },
  ...extra,
});

async function collect(stream: AsyncIterable<RouterEvent>) {
  const events: RouterEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

const text = (events: RouterEvent[]) => {
  let out = '';
  for (const e of events) {
    if (e.type === 'text-delta') out += e.text;
    if (e.type === 'reset') out = '';
  }
  return out;
};

test('happy path: first candidate answers, ledger and finish cost agree', async () => {
  const t = createTestRouter();
  t.adapter('anthropic').queue('anthropic/sonnet', { steps: [{ kind: 'text', text: 'Hello there', chunks: 3 }], usage: { inputTokens: 3000, outputTokens: 600 } });
  const events = await collect(t.router.stream(ask('hi')));
  const finish = events.at(-1);
  assert.equal(finish?.type, 'finish');
  if (finish?.type !== 'finish') return;
  assert.equal(finish.modelId, 'anthropic/sonnet');
  assert.equal(text(events), 'Hello there');
  assert.equal(finish.costNanoUsd, usd(0.012));
  assert.equal(t.ledgerStore.events.length, 1);
  assert.equal(t.ledgerStore.events[0]?.cost, finish.costNanoUsd);
});

test('429 with retry-after: cool down, fail over transparently, skip while cooling', async () => {
  const t = createTestRouter();
  t.adapter('anthropic').queue('anthropic/sonnet', { steps: [{ kind: 'error', errorClass: 'rate_limited', status: 429, retryAfterMs: 30_000 }] });
  t.adapter('openai').queue('openai/sol', { steps: [{ kind: 'text', text: 'from openai' }] }, { steps: [{ kind: 'text', text: 'again openai' }] });

  const first = await collect(t.router.stream(ask('hi')));
  assert.equal(text(first), 'from openai');
  assert.ok(!first.some((e) => e.type === 'reset'), 'no reset: nothing was streamed before the failure');
  assert.deepEqual(t.ledgerStore.events.map((e) => [e.modelId, e.outcome, e.errorClass]), [
    ['anthropic/sonnet', 'error', 'rate_limited'],
    ['openai/sol', 'ok', undefined],
  ]);

  const second = await collect(t.router.stream(ask('hi again')));
  const fin = second.at(-1);
  assert.ok(fin?.type === 'finish' && fin.attempts[0]?.outcome === 'skipped' && fin.attempts[0].modelId === 'anthropic/sonnet');
  assert.equal(t.adapter('anthropic').calls.length, 1, 'cooling model was not called again');

  t.clock.advance(30_001);
  t.adapter('anthropic').queue('anthropic/sonnet', { steps: [{ kind: 'text', text: 'anthropic is back' }] });
  assert.equal(text(await collect(t.router.stream(ask('third')))), 'anthropic is back');
});

test('500, then a hang that times out, then the same model through OpenRouter answers', async () => {
  const t = createTestRouter({ timeouts: { firstTokenMs: 40, totalMs: 1000 } });
  t.adapter('anthropic').queue('anthropic/sonnet', { steps: [{ kind: 'error', errorClass: 'server_error', status: 500 }] });
  t.adapter('openai').queue('openai/sol', { steps: [{ kind: 'hang' }] });
  t.adapter('google').queue('google/flash', { steps: [{ kind: 'error', errorClass: 'overloaded', status: 503 }] });
  t.adapter('openrouter').queue('openrouter/sonnet', { steps: [{ kind: 'text', text: 'via openrouter' }] });
  const events = await collect(t.router.stream(ask('hi')));
  assert.equal(text(events), 'via openrouter');
  assert.deepEqual(t.ledgerStore.events.map((e) => e.errorClass ?? 'ok'), ['server_error', 'timeout', 'overloaded', 'ok']);
});

test('mid-stream failure (interactive): reset event, partial text discarded', async () => {
  const t = createTestRouter();
  t.adapter('anthropic').queue('anthropic/sonnet', { steps: [{ kind: 'text', text: 'Partial ans' }, { kind: 'error', errorClass: 'server_error', status: 500 }] });
  t.adapter('openai').queue('openai/sol', { steps: [{ kind: 'text', text: 'Complete answer.' }] });
  const events = await collect(t.router.stream(ask('hi')));
  assert.ok(events.some((e) => e.type === 'reset'));
  assert.equal(text(events), 'Complete answer.');
  const result = await (async () => {
    t.adapter('anthropic').queue('anthropic/sonnet', { steps: [{ kind: 'text', text: 'oops' }, { kind: 'error', errorClass: 'network' }] });
    t.adapter('openai').queue('openai/sol', { steps: [{ kind: 'text', text: 'clean' }] });
    t.clock.advance(60_000);
    return t.router.generate(ask('again'));
  })();
  assert.equal(result.text, 'clean');
});

test('mid-stream failure (background): error surfaces, no reset, job retry handles it', async () => {
  const t = createTestRouter();
  t.adapter('anthropic').queue('anthropic/haiku', { steps: [{ kind: 'text', text: 'half' }, { kind: 'error', errorClass: 'server_error' }] });
  await assert.rejects(collect(t.router.stream({ ...ask('extract'), route: 'memory.extract', tier: undefined })), (e: unknown) => e instanceof ProviderError && e.errorClass === 'server_error');
});

test('background retries the same cheap model with backoff before failing over', async () => {
  const t = createTestRouter();
  t.adapter('anthropic').queue(
    'anthropic/haiku',
    { steps: [{ kind: 'error', errorClass: 'server_error' }] },
    { steps: [{ kind: 'error', errorClass: 'network' }] },
    { steps: [{ kind: 'text', text: '{"candidates":[]}' }] },
  );
  const r = await t.router.generate({ ...ask('extract'), route: 'memory.extract', tier: undefined });
  assert.equal(r.finish.modelId, 'anthropic/haiku');
  assert.equal(t.waits.length, 2);
  assert.equal(t.adapter('openai').calls.length, 0);
});

test('background work never escalates to a pricier tier', async () => {
  const t = createTestRouter();
  for (const [provider, model] of [['anthropic', 'anthropic/haiku'], ['openai', 'openai/luna'], ['google', 'google/flash-lite']] as const) {
    t.adapter(provider).queue(model, ...Array.from({ length: 3 }, () => ({ steps: [{ kind: 'error' as const, errorClass: 'overloaded' as const }] })));
  }
  await assert.rejects(t.router.generate({ ...ask('extract'), route: 'memory.extract', tier: undefined }), AllCandidatesFailedError);
  const called = [...t.adapters.values()].flatMap((a) => a.calls.map((c) => c.modelId));
  assert.ok(called.every((id) => ['anthropic/haiku', 'openai/luna', 'google/flash-lite'].includes(id)), called.join(','));
});

test('quota exhausted disables the whole provider; invalid requests are not retried', async () => {
  const t = createTestRouter();
  t.adapter('anthropic').queue('anthropic/sonnet', { steps: [{ kind: 'error', errorClass: 'quota_exhausted', status: 400, message: 'credit balance is too low' }] });
  await t.router.generate(ask('hi'));
  const plan = await t.router.generate({ ...ask('hard one'), tier: 'frontier' });
  assert.equal(plan.finish.modelId, 'openai/astra', 'anthropic/opus skipped: provider disabled');
  assert.equal(plan.finish.attempts[0]?.reason, 'provider disabled (quota_exhausted)');

  const t2 = createTestRouter();
  t2.adapter('anthropic').queue('anthropic/sonnet', { steps: [{ kind: 'error', errorClass: 'invalid_request', status: 400 }] });
  await assert.rejects(t2.router.generate(ask('bad')), (e: unknown) => e instanceof ProviderError && e.errorClass === 'invalid_request');
  assert.equal(t2.adapter('openai').calls.length, 0);
});

test('sensitivity and capabilities filter candidates', () => {
  const t = createTestRouter();
  const plan = t.router.plan({ ...ask('private stuff'), sensitivity: 'private' });
  assert.ok(!plan.candidates.some((c) => c.provider.id === 'google'));
  assert.match(plan.excluded.find((e) => e.modelId === 'google/flash')?.reason ?? '', /private/);

  const tools = t.router.plan({ ...ask('use a tool'), route: 'memory.extract', tier: undefined, tools: [{ name: 'x', description: 'x', parameters: { type: 'object' } }] });
  assert.ok(!tools.candidates.some((c) => c.model.id === 'google/flash-lite'), 'flash-lite has no tool support');

  assert.throws(() => t.router.plan({ ...ask('secret'), sensitivity: 'secret' }), NoCandidatesError);
});

test('budgets: interactive asks the owner, background defers to the next period', async () => {
  const budgets: Budget[] = [
    { id: 'g', name: 'Global daily', scope: { type: 'global' }, period: 'day', limit: usd(0.03), softThresholds: [], onLimit: { interactive: 'ask', background: 'defer' }, enabled: true },
  ];
  const t = createTestRouter({ budgets });
  // The worst-case estimate (1,024 output tokens at $10/M ≈ $0.0102) fits; the call then spends the full $0.03.
  t.adapter('anthropic').queue('anthropic/sonnet', { steps: [{ kind: 'text', text: 'x' }], usage: { inputTokens: 15_000, outputTokens: 0 } });
  await t.router.generate(ask('hi'));
  await assert.rejects(t.router.generate(ask('more')), BudgetApprovalNeededError);
  await assert.rejects(t.router.generate({ ...ask('bg'), route: 'memory.extract', tier: undefined }), (e: unknown) => e instanceof DeferredError && new Date(e.retryAt).toISOString() === '2026-11-08T00:00:00.000Z');
  assert.equal(t.budgetStore.activeReservationCount(), 0);
});

test('cancellation aborts the stream, records it, and releases the reservation', async () => {
  const budgets: Budget[] = [{ id: 'g', name: 'G', scope: { type: 'global' }, period: 'day', limit: usd(10), softThresholds: [], onLimit: { interactive: 'ask', background: 'defer' }, enabled: true }];
  const t = createTestRouter({ budgets });
  t.adapter('anthropic').queue('anthropic/sonnet', { steps: [{ kind: 'text', text: 'streaming slowly', chunks: 8, delayMs: 20 }] });
  const controller = new AbortController();
  const events: RouterEvent[] = [];
  await assert.rejects(
    (async () => {
      for await (const e of t.router.stream(ask('hi', { signal: controller.signal }))) {
        events.push(e);
        if (e.type === 'text-delta') controller.abort('owner pressed stop');
      }
    })(),
    (e: unknown) => e instanceof ProviderError && e.errorClass === 'cancelled',
  );
  assert.equal(t.ledgerStore.events.at(-1)?.outcome, 'cancelled');
  assert.equal(t.budgetStore.activeReservationCount(), 0);
  assert.equal(t.adapter('openai').calls.length, 0, 'cancellation is not failed over');
});

test('circuit breaker: opens after 5 failures, half-open probe, closes on success', async () => {
  const t = createTestRouter();
  for (let i = 0; i < 5; i++) {
    t.adapter('anthropic').queue('anthropic/sonnet', { steps: [{ kind: 'error', errorClass: 'server_error' }] });
    t.adapter('openai').queue('openai/sol', { steps: [{ kind: 'text', text: 'ok' }] });
    await t.router.generate(ask(`q${i}`));
  }
  const snap = t.health.snapshot().models.find((m) => m.modelId === 'anthropic/sonnet');
  assert.equal(snap?.state, 'open');
  t.clock.advance(31_000);
  t.adapter('anthropic').queue('anthropic/sonnet', { steps: [{ kind: 'text', text: 'recovered' }] });
  assert.equal((await t.router.generate(ask('probe'))).text, 'recovered');
  assert.equal(t.health.snapshot().models.find((m) => m.modelId === 'anthropic/sonnet')?.state, 'closed');
});

test('provider-specific state is dropped when a conversation moves to another provider', async () => {
  const t = createTestRouter();
  t.adapter('anthropic').queue('anthropic/sonnet', { steps: [{ kind: 'error', errorClass: 'overloaded' }] });
  t.adapter('openai').queue('openai/sol', { steps: [{ kind: 'text', text: 'ok' }] });
  await t.router.generate(
    ask('continue', {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello', providerState: { providerKind: 'anthropic', data: { signature: 'abc' } } },
        { role: 'user', content: 'continue' },
      ],
    }),
  );
  const sentToAnthropic = t.adapter('anthropic').calls[0]!.request.messages[1];
  const sentToOpenai = t.adapter('openai').calls[0]!.request.messages[1];
  assert.ok(sentToAnthropic?.role === 'assistant' && sentToAnthropic.providerState);
  assert.ok(sentToOpenai?.role === 'assistant' && !sentToOpenai.providerState);
});

test('embeddings: metered, no cross-model failover', async () => {
  const t = createTestRouter();
  const r = await t.router.embed({ texts: ['my sister is Leila', 'sisters named Leila'], priority: 'routine', attribution: { taskType: 'memory.embed' } });
  assert.equal(r.vectors.length, 2);
  assert.equal(r.modelId, 'openai/embed-small');
  assert.equal(t.ledgerStore.events[0]?.route, 'embed');
});

test('complexity classifier picks tiers from cheap features', () => {
  const msg = (content: string) => [{ role: 'user' as const, content }];
  assert.equal(classifyComplexity(msg('hi, how are you?')).tier, 'fast');
  assert.equal(classifyComplexity(msg('Please think hard about this')).tier, 'frontier');
  const debug = 'Can you debug this and compare two approaches, then plan a refactor?\n```ts\nconst x = 1;\n```\n' + 'details '.repeat(200);
  assert.notEqual(classifyComplexity(msg(debug)).tier, 'fast');
  assert.equal(classifyComplexity(msg('quick: analyze and compare A vs B')).tier, 'fast');
});
