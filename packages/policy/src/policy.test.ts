import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '@feroxes/shared';
import {
  ApprovalService,
  AuditLog,
  InMemoryApprovalStore,
  InMemoryAuditStore,
  InMemorySystemStateStore,
  PolicyEngine,
  SystemControl,
  TaintSet,
} from './index.ts';

async function setup(preset: 'observer' | 'assistant' | 'delegate' | 'autopilot' = 'assistant') {
  const system = new SystemControl({ store: new InMemorySystemStateStore() });
  await system.init();
  const policy = new PolicyEngine({ config: { preset }, system });
  return { system, policy };
}

const action = (category: Parameters<PolicyEngine['decide']>[0]['category'], extra: Partial<Parameters<PolicyEngine['decide']>[0]> = {}) => ({
  tool: 'x.tool',
  category,
  args: {},
  taint: new TaintSet(),
  actor: 'agent' as const,
  ...extra,
});

test('presets: assistant allows reads and internal writes, asks for outward actions', async () => {
  const { policy } = await setup('assistant');
  assert.equal(policy.decide(action('read')).level, 'allow');
  assert.equal(policy.decide(action('internal_write')).level, 'allow');
  assert.equal(policy.decide(action('communicate')).level, 'ask');
  assert.equal(policy.decide(action('destructive')).level, 'ask');
  const observer = (await setup('observer')).policy;
  assert.equal(observer.decide(action('communicate')).level, 'deny');
});

test('hard floor: financial and security always ask, even with allow overrides', async () => {
  const { policy } = await setup('autopilot');
  policy.setConfig({ preset: 'autopilot', categoryOverrides: { financial: 'allow' }, toolOverrides: { 'settings.change': 'allow' } });
  const fin = policy.decide(action('financial'));
  assert.equal(fin.level, 'ask');
  assert.equal(fin.rule, 'hard_floor');
  assert.equal(policy.decide(action('security', { tool: 'settings.change' })).level, 'ask');
  // A deny override stays deny.
  policy.setConfig({ preset: 'autopilot', categoryOverrides: { financial: 'deny' } });
  assert.equal(policy.decide(action('financial')).level, 'deny');
});

test('taint: outward actions in a run that read untrusted content need approval', async () => {
  const { policy } = await setup('autopilot');
  const taint = new TaintSet([{ kind: 'web', source: 'https://evil.example/page', at: 0 }]);
  const d = policy.decide(action('external_write', { taint }));
  assert.equal(d.level, 'ask');
  assert.equal(d.rule, 'taint');
  assert.match(d.reason, /evil\.example/);
  // Reads and internal writes are not escalated.
  assert.equal(policy.decide(action('read', { taint })).level, 'allow');
  assert.equal(policy.decide(action('internal_write', { taint })).level, 'allow');
});

test('kill switch: stop aborts tracked work, denies everything, persists, owner-only resume', async () => {
  const store = new InMemorySystemStateStore();
  const system = new SystemControl({ store });
  await system.init();
  const policy = new PolicyEngine({ config: { preset: 'autopilot' }, system });
  const a = system.track('run-1');
  const b = system.track('run-2');
  const { aborted } = await system.stop('owner', 'testing STOP');
  assert.equal(aborted, 2);
  assert.ok(a.signal.aborted && b.signal.aborted);
  assert.equal(policy.decide(action('read')).level, 'deny');
  assert.throws(() => system.track('run-3'), /stopped/);

  // A restarted Core comes back stopped.
  const restarted = new SystemControl({ store });
  assert.equal(await restarted.init(), 'stopped');
  await restarted.resume('owner', 'all clear');
  assert.equal(restarted.state, 'running');
  await assert.rejects(restarted.resume('agent' as 'owner', 'sneaky'), /only the owner/);
});

test('audit log: hash chain verifies, detects edits, deletions and reordering', async () => {
  const store = new InMemoryAuditStore();
  const log = new AuditLog({ store, clock: new ManualClock(1000) });
  for (let i = 0; i < 5; i++) {
    await log.append({ actor: 'agent', action: 'files.write', category: 'internal_write', decision: 'allow', outcome: 'success', summary: `wrote note ${i}`, details: { path: `n${i}.md`, apiKey: 'should-be-redacted' } });
  }
  assert.deepEqual((await log.verify()).ok, true);
  assert.equal(store.entries[0]?.details?.apiKey, '[redacted]');

  const original = store.entries[2]!.summary;
  store.entries[2]!.summary = 'nothing to see here';
  assert.deepEqual(await log.verify(), { ok: false, brokenAtSeq: 3, reason: 'content hash mismatch' });
  store.entries[2]!.summary = original;

  const removed = store.entries.splice(1, 1);
  const broken = await log.verify();
  assert.equal(broken.ok, false);
  store.entries.splice(1, 0, ...removed);
  assert.equal((await log.verify()).ok, true);
});

test('audit log stays linear under concurrent appends', async () => {
  const store = new InMemoryAuditStore();
  const log = new AuditLog({ store });
  await Promise.all(Array.from({ length: 50 }, (_, i) => log.append({ actor: 'system', action: 'x', decision: 'system', outcome: 'success', summary: String(i) })));
  const v = await log.verify();
  assert.ok(v.ok && v.count === 50);
});

test('approvals: decide once, edits recorded, expiry enforced', async () => {
  const clock = new ManualClock(0);
  const approvals = new ApprovalService({ store: new InMemoryApprovalStore(), clock, ttlMs: 1000 });
  const base = { runId: 'r', toolCallId: 'c', tool: 'files.delete', category: 'destructive' as const, args: { path: 'a.txt' }, preview: { title: 'Delete a.txt' }, agentReason: 'cleanup', policyReason: 'destructive → ask', taint: [] };
  const a = await approvals.request(base);
  const decided = await approvals.decide(a.id, { approve: true, editedArgs: { path: 'b.txt' } });
  assert.equal(decided.status, 'approved');
  assert.deepEqual(decided.editedArgs, { path: 'b.txt' });
  await assert.rejects(approvals.decide(a.id, { approve: false }), /already approved/);

  const late = await approvals.request(base);
  clock.advance(1001);
  await assert.rejects(approvals.decide(late.id, { approve: true }), /already expired/);
});
