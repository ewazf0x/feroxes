import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryEventBus,
  ManualClock,
  backoffMs,
  canonicalJson,
  contentHash,
  costPerMillion,
  createJsonLogger,
  formatUsd,
  isUuidv7,
  sleep,
  usd,
  uuidv7,
  uuidv7Time,
} from './index.ts';

test('uuidv7: valid format, time-ordered, strictly increasing within a millisecond', () => {
  const now = Date.UTC(2026, 10, 7);
  const ids = Array.from({ length: 2000 }, () => uuidv7(now));
  for (const id of ids) assert.ok(isUuidv7(id), id);
  const sorted = [...ids].sort();
  assert.deepEqual(sorted, ids, 'ids generated in one millisecond must sort in creation order');
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(Math.abs(uuidv7Time(ids[0]!) - now) <= 1);
});

test('money: integer nano-dollars, exact sums, per-million pricing', () => {
  assert.equal(usd(1), 1_000_000_000);
  // 1,000 tokens at $0.02 per 1M tokens = $0.00002
  assert.equal(costPerMillion(1000, 0.02), 20_000);
  // 3k input at $2/M + 600 output at $10/M = $0.006 + $0.006
  assert.equal(costPerMillion(3000, 2) + costPerMillion(600, 10), usd(0.012));
  let total = 0;
  for (let i = 0; i < 1000; i++) total += costPerMillion(1, 0.1);
  assert.equal(total, costPerMillion(1000, 0.1), 'no floating-point drift');
  assert.equal(formatUsd(usd(1.5)), '$1.50');
  assert.equal(formatUsd(usd(0.0123)), '$0.0123');
});

test('canonicalJson ignores key order and undefined values', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: undefined, c: [2, 1] } }), canonicalJson({ a: { c: [2, 1] }, b: 1 }));
  assert.equal(contentHash('  Hello   World '), contentHash('hello world'));
});

test('event bus: topic and wildcard delivery; failing subscriber does not break publisher', () => {
  const errors: unknown[] = [];
  const bus = new InMemoryEventBus<{ 'a.b': { n: number } }>({ onHandlerError: (e) => errors.push(e) });
  const seen: number[] = [];
  bus.subscribe('a.b', () => {
    throw new Error('boom');
  });
  bus.subscribe('*', (e) => seen.push((e.payload as { n: number }).n));
  const unsubscribe = bus.subscribe('a.b', (e) => seen.push(e.payload.n * 10));
  bus.publish('a.b', { n: 1 });
  unsubscribe();
  const second = bus.publish('a.b', { n: 2 });
  assert.deepEqual(seen, [10, 1, 2]);
  assert.equal(errors.length, 2);
  assert.equal(second.seq, 2);
});

test('logger redacts secrets at any depth', () => {
  const lines: string[] = [];
  const log = createJsonLogger({ write: (l) => lines.push(l) });
  log.info('call', { headers: { Authorization: 'Bearer sk-123', accept: 'json' }, apiKey: 'k', nested: [{ password: 'p' }] });
  const entry = JSON.parse(lines[0]!);
  assert.equal(entry.headers.Authorization, '[redacted]');
  assert.equal(entry.headers.accept, 'json');
  assert.equal(entry.apiKey, '[redacted]');
  assert.equal(entry.nested[0].password, '[redacted]');
  assert.ok(!lines[0]!.includes('sk-123'));
});

test('sleep honors abort; backoff stays within bounds; manual clock advances', async () => {
  const controller = new AbortController();
  const pending = sleep(10_000, controller.signal);
  controller.abort('stop');
  await assert.rejects(pending, /aborted/);
  for (let i = 0; i < 20; i++) assert.ok(backoffMs(i, 500, 30_000) <= 30_000);
  const clock = new ManualClock(0);
  clock.advance(1500);
  assert.equal(clock.now(), 1500);
});
