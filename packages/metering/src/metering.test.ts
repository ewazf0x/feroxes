import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR, ManualClock, type PowerMode, type SystemState, usd } from '@feroxes/shared';
import {
  type Budget,
  BudgetGate,
  InMemoryBudgetStore,
  InMemoryUsageLedgerStore,
  type ModelPrice,
  PriceBook,
  SpendAnomalyDetector,
  type ThresholdAlert,
  UsageLedger,
  computeCost,
} from './index.ts';

const sonnet: ModelPrice = {
  id: 'p1',
  modelId: 'anthropic/sonnet',
  effectiveFrom: 0,
  inputPerMTok: 2,
  outputPerMTok: 10,
  cachedInputPerMTok: 0.2,
  cacheWritePerMTok: 2.5,
  contextTiers: [{ aboveInputTokens: 200_000, inputPerMTok: 4, outputPerMTok: 15 }],
  batchDiscount: 0.5,
};

test('cost: fresh, cached and cache-write input are priced separately', () => {
  // 12k input: 9k cached, 1k cache write, 2k fresh; 600 output.
  const c = computeCost(sonnet, { inputTokens: 12_000, cachedInputTokens: 9_000, cacheWriteTokens: 1_000, outputTokens: 600 });
  assert.equal(c.input, usd(0.004)); // 2k × $2/M
  assert.equal(c.cachedInput, usd(0.0018)); // 9k × $0.2/M
  assert.equal(c.cacheWrite, usd(0.0025)); // 1k × $2.5/M
  assert.equal(c.output, usd(0.006)); // 600 × $10/M
  assert.equal(c.total, usd(0.0143));
});

test('cost: long-context tier and batch discount', () => {
  const long = computeCost(sonnet, { inputTokens: 250_000, outputTokens: 1000 });
  assert.equal(long.total, usd(1.0 + 0.015)); // 250k × $4/M + 1k × $15/M
  const batch = computeCost(sonnet, { inputTokens: 100_000, outputTokens: 0, batch: true });
  assert.equal(batch.total, usd(0.1)); // $0.20 at half price
  const longBatch = computeCost(sonnet, { inputTokens: 1_000_000, outputTokens: 0, batch: true });
  assert.equal(longBatch.total, usd(2)); // long-context rate $4/M, then half price
});

test('price book returns the price valid at call time', () => {
  const book = new PriceBook([
    { ...sonnet, id: 'old', effectiveFrom: 0, effectiveTo: 1000 },
    { ...sonnet, id: 'new', effectiveFrom: 1000, inputPerMTok: 1 },
  ]);
  assert.equal(book.priceAt('anthropic/sonnet', 999)?.id, 'old');
  assert.equal(book.priceAt('anthropic/sonnet', 1000)?.id, 'new');
  assert.equal(book.priceAt('missing', 1000), undefined);
});

test('ledger prices calls at call time and flags unpriced models', async () => {
  const clock = new ManualClock(5000);
  const ledger = new UsageLedger({ store: new InMemoryUsageLedgerStore(), prices: new PriceBook([sonnet]), clock });
  const base = { providerId: 'anthropic', route: 'chat.turn', taskType: 'chat', priority: 'interactive' as const, attempt: 1, outcome: 'ok' as const };
  const a = await ledger.record({ ...base, modelId: 'anthropic/sonnet', usage: { inputTokens: 3000, outputTokens: 600 } });
  const b = await ledger.record({ ...base, modelId: 'unknown/model', outcome: 'error', errorClass: 'rate_limited', usage: { inputTokens: 0, outputTokens: 0 } });
  assert.equal(a.cost, usd(0.012));
  assert.equal(a.unpriced, false);
  assert.equal(b.unpriced, true);
  const byModel = await ledger.summarize({}, 'modelId');
  assert.equal(byModel[0]?.key, 'anthropic/sonnet');
  assert.equal(byModel.find((r) => r.key === 'unknown/model')?.errors, 1);
});

function budgets(): Budget[] {
  return [
    { id: 'global-day', name: 'Global daily', scope: { type: 'global' }, period: 'day', limit: usd(2), interactiveReserve: usd(0.5), softThresholds: [50, 80, 95], onLimit: { interactive: 'ask', background: 'defer' }, enabled: true },
    { id: 'background-day', name: 'Background daily', scope: { type: 'priority', priorities: ['routine', 'deferrable'] }, period: 'day', limit: usd(0.05), softThresholds: [80], onLimit: { interactive: 'ask', background: 'defer' }, enabled: true },
  ];
}

function gate(opts: { mode?: PowerMode; state?: SystemState; clock?: ManualClock; onThreshold?: (a: ThresholdAlert) => void } = {}) {
  const store = new InMemoryBudgetStore(budgets());
  const clock = opts.clock ?? new ManualClock(Date.UTC(2026, 10, 7, 12));
  const g = new BudgetGate({
    store,
    timeZone: 'UTC',
    clock,
    safetyFactor: 1,
    powerMode: () => opts.mode ?? 'normal',
    systemState: () => opts.state ?? 'running',
    ...(opts.onThreshold ? { onThreshold: opts.onThreshold } : {}),
  });
  return { g, store, clock };
}

const req = (priority: 'interactive' | 'routine', estimate: number, id = 'r') => ({ requestId: id, estimate, priority, providerId: 'anthropic', route: 'memory.extract' });

test('20 concurrent background jobs never overshoot the budget', async () => {
  const { g, store } = gate();
  const results = await Promise.all(
    Array.from({ length: 20 }, async (_, i) => {
      const r = await g.reserve(req('routine', usd(0.004), `job${i}`));
      if (!r.ok) return r;
      await new Promise((res) => setTimeout(res, Math.random() * 5)); // calls finish in random order
      await g.settle(r.reservationId, usd(0.004));
      return r;
    }),
  );
  const admitted = results.filter((r) => r.ok).length;
  const denied = results.filter((r) => !r.ok);
  assert.equal(admitted, 12); // floor($0.05 / $0.004)
  assert.ok(denied.every((d) => !d.ok && d.action === 'defer' && d.budgetId === 'background-day'));
  const c = await store.counter('background-day', Date.UTC(2026, 10, 7));
  assert.ok(c.spent <= usd(0.05), `spent ${c.spent}`);
  assert.equal(c.reserved, 0);
  assert.equal(store.activeReservationCount(), 0);
});

test('interactive work can use the reserve that background work cannot', async () => {
  const { g } = gate();
  // Background can use $2 - $0.50 = $1.50 of the global daily budget (background budget aside).
  const bg = await g.reserve({ ...req('routine', usd(1.6)), route: 'x' });
  assert.equal(bg.ok, false);
  const fg = await g.reserve(req('interactive', usd(1.6)));
  assert.equal(fg.ok, true);
});

test('over the limit, interactive requests get "ask" and a reset time', async () => {
  const { g } = gate();
  const first = await g.reserve(req('interactive', usd(1.9)));
  assert.ok(first.ok);
  await g.settle(first.reservationId, usd(1.9));
  const second = await g.reserve(req('interactive', usd(0.2)));
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.action, 'ask');
  assert.equal(new Date(second.retryAt).toISOString(), '2026-11-08T00:00:00.000Z');
});

test('released and expired reservations free their budget', async () => {
  const { g, store, clock } = gate();
  const a = await g.reserve(req('routine', usd(0.03)));
  assert.ok(a.ok);
  assert.equal((await g.reserve(req('routine', usd(0.03)))).ok, false);
  await g.release(a.reservationId);
  const b = await g.reserve(req('routine', usd(0.03)));
  assert.ok(b.ok);
  clock.advance(11 * 60_000);
  assert.equal(await g.sweepExpired(), 1);
  assert.equal(store.activeReservationCount(), 0);
  assert.equal((await g.reserve(req('routine', usd(0.03)))).ok, true);
});

test('threshold alerts fire once per threshold per period', async () => {
  const alerts: ThresholdAlert[] = [];
  const { g } = gate({ onThreshold: (a) => alerts.push(a) });
  for (const amount of [0.9, 0.2, 0.1, 0.5]) {
    const r = await g.reserve(req('interactive', usd(amount)));
    assert.ok(r.ok);
    await g.settle(r.reservationId, usd(amount));
  }
  // Global: $0.90 (45%), $1.10 (55% → 50), $1.20 (60%), $1.70 (85% → 80)
  assert.deepEqual(alerts.filter((a) => a.budgetId === 'global-day').map((a) => a.threshold), [50, 80]);
});

test('admission follows power modes, the kill switch and exhausted budgets', async () => {
  assert.deepEqual(await gate().g.admit('routine'), { admitted: true });
  assert.equal((await gate({ state: 'stopped' }).g.admit('interactive')).admitted, false);
  assert.equal((await gate({ mode: 'background_paused' }).g.admit('routine')).admitted, false);
  assert.equal((await gate({ mode: 'background_paused' }).g.admit('interactive')).admitted, true);

  const economy = await gate({ mode: 'economy' }).g.admit('routine');
  assert.deepEqual(economy, { admitted: true, tierCap: 'fast' });
  const deferNoon = await gate({ mode: 'economy' }).g.admit('deferrable');
  assert.equal(deferNoon.admitted, false); // noon UTC is outside the 02:00–06:00 window
  if (!deferNoon.admitted) assert.equal(new Date(deferNoon.retryAt).getUTCHours(), 2);
  const night = await gate({ mode: 'economy', clock: new ManualClock(Date.UTC(2026, 10, 7, 3)) }).g.admit('deferrable');
  assert.equal(night.admitted, true);

  const { g } = gate();
  const r = await g.reserve(req('routine', usd(0.05)));
  assert.ok(r.ok);
  await g.settle(r.reservationId, usd(0.05));
  const exhausted = await g.admit('routine');
  assert.equal(exhausted.admitted, false);
  if (!exhausted.admitted) assert.match(exhausted.reason, /Background daily/);
  assert.equal((await g.admit('interactive')).admitted, true);
});

test('spend anomaly: last hour far above the trailing average', async () => {
  const clock = new ManualClock(Date.UTC(2026, 10, 7, 12));
  const ledger = new UsageLedger({ store: new InMemoryUsageLedgerStore(), prices: new PriceBook([{ ...sonnet, modelId: 'm' }]), clock });
  const call = { providerId: 'p', modelId: 'm', route: 'r', taskType: 't', priority: 'routine' as const, attempt: 1, outcome: 'ok' as const };
  clock.advance(-3 * 24 * HOUR);
  for (let i = 0; i < 10; i++) await ledger.record({ ...call, usage: { inputTokens: 10_000, outputTokens: 1_000 } }); // $0.03 each
  clock.advance(3 * 24 * HOUR - 30 * 60_000);
  const detector = new SpendAnomalyDetector({ ledger, clock });
  assert.equal((await detector.check()).anomalous, false);
  for (let i = 0; i < 20; i++) await ledger.record({ ...call, usage: { inputTokens: 10_000, outputTokens: 1_000 } });
  const result = await detector.check();
  assert.equal(result.anomalous, true);
  assert.equal(result.lastHour, usd(0.6));
});
