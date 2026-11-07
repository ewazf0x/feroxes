import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mutex, nextPeriodStart, periodStart, zonedTime } from './index.ts';

const iso = (ts: number) => new Date(ts).toISOString();

test('day/week/month periods follow the owner time zone', () => {
  // 2026-11-07 is a Saturday. 01:30 UTC is still Nov 6 in New York (UTC-5 after DST ends Nov 1).
  const ts = Date.UTC(2026, 10, 7, 1, 30);
  assert.equal(iso(periodStart('day', ts, 'America/New_York')), '2026-11-06T05:00:00.000Z');
  assert.equal(iso(periodStart('day', ts, 'UTC')), '2026-11-07T00:00:00.000Z');
  assert.equal(iso(periodStart('day', ts, 'Asia/Kolkata')), '2026-11-06T18:30:00.000Z');
  // Week starts on Monday 2026-11-02 local.
  assert.equal(iso(periodStart('week', ts, 'UTC')), '2026-11-02T00:00:00.000Z');
  assert.equal(iso(periodStart('month', ts, 'Europe/Berlin')), '2026-10-31T23:00:00.000Z');
  assert.equal(iso(nextPeriodStart('month', ts, 'Europe/Berlin')), '2026-11-30T23:00:00.000Z');
  assert.equal(iso(nextPeriodStart('day', ts, 'UTC')), '2026-11-08T00:00:00.000Z');
  assert.equal(iso(nextPeriodStart('week', ts, 'UTC')), '2026-11-09T00:00:00.000Z');
});

test('periods across a DST change are 23 or 25 hours long', () => {
  // US DST ended on 2026-11-01 at 02:00 local: that local day lasts 25 hours.
  const start = zonedTime('America/New_York', 2026, 11, 1);
  const next = nextPeriodStart('day', start + 3_600_000, 'America/New_York');
  assert.equal(next - start, 25 * 3_600_000);
  // Europe DST started 2026-03-29: 23-hour day.
  const s2 = zonedTime('Europe/Berlin', 2026, 3, 29);
  assert.equal(nextPeriodStart('day', s2 + 3_600_000, 'Europe/Berlin') - s2, 23 * 3_600_000);
});

test('mutex serializes critical sections', async () => {
  const m = new Mutex();
  const log: string[] = [];
  await Promise.all(
    [1, 2, 3].map((n) =>
      m.run(async () => {
        log.push(`start${n}`);
        await new Promise((r) => setTimeout(r, 5));
        log.push(`end${n}`);
      }),
    ),
  );
  assert.deepEqual(log, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3']);
});
