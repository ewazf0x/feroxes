import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentHarness } from '@feroxes/agent';
import { createTestRouter, type MockResponse } from '@feroxes/llm';
import { MemoryService, routerEmbedder } from '@feroxes/memory';
import { type Budget, BudgetGate } from '@feroxes/metering';
import { AuditLog } from '@feroxes/policy';
import { ManualClock, usd } from '@feroxes/shared';
import { Db, openStores } from './index.ts';

const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'feroxes-db-')), 'feroxes.db');
const say = (text: string): MockResponse => ({ steps: [{ kind: 'text', text }] });
const callTool = (name: string, args: unknown): MockResponse => ({ steps: [{ kind: 'tool', name, args }] });

test('migrations run once and the schema version is recorded', () => {
  const path = tmpDb();
  const a = new Db(path);
  assert.equal(a.version, 2);
  a.close();
  const b = new Db(path);
  assert.equal(b.version, 2);
  b.close();
});

test('Feroxes remembers across a restart: memory, conversation, audit and STOP all persist', async () => {
  const path = tmpDb();
  const clock = new ManualClock(Date.UTC(2026, 10, 8, 9));
  let stores = openStores(path);
  const harness = (st: typeof stores) =>
    createAgentHarness({ clock, router: createTestRouter({ clock }), stores: { memory: st.memory, system: st.system, approvals: st.approvals, audit: st.audit, toolCalls: st.toolCalls, artifacts: st.artifacts, agent: st.agent } });

  const h1 = await harness(stores);
  h1.t.adapter('anthropic').queue('anthropic/sonnet', callTool('memory__save', { content: 'The owner\'s dog is called Bruno.', kind: 'fact', importance: 0.8 }), say('Noted.'));
  const session = await h1.runtime.createSession();
  await (await h1.runtime.sendMessage(session.id, 'Remember my dog is called Bruno.', { tier: 'balanced' })).done;
  await h1.system.stop('owner', 'going to sleep');
  stores.db.close(); // the process "dies"

  stores = openStores(path);
  const h2 = await harness(stores);
  assert.equal(h2.system.state, 'stopped', 'STOP survives a restart');
  await h2.system.resume('owner', 'morning');
  const memories = await stores.memory.list({ statuses: ['active'] });
  assert.equal(memories[0]?.content, "The owner's dog is called Bruno.");
  const hits = await h2.memory.search({ text: 'what is my dog called' });
  assert.match(hits[0]?.memory.content ?? '', /Bruno/);
  assert.equal((await stores.agent.messages(session.id)).length, 4, 'user, assistant (tool call), tool, assistant');
  assert.equal((await h2.audit.verify()).ok, true);
  stores.db.close();
});

test('the audit table rejects edits and deletions at the database level', async () => {
  const stores = openStores(tmpDb());
  const log = new AuditLog({ store: stores.audit });
  await log.append({ actor: 'agent', action: 'x.y', decision: 'allow', outcome: 'success', summary: 'did a thing' });
  assert.throws(() => stores.db.run("UPDATE audit SET data = '{}'"), /append-only/);
  assert.throws(() => stores.db.run('DELETE FROM audit'), /append-only/);
  assert.equal((await log.verify()).ok, true);
  stores.db.close();
});

test('budget reservations stay atomic in SQLite under 20 concurrent jobs', async () => {
  const budgets: Budget[] = [{ id: 'bg', name: 'Background daily', scope: { type: 'priority', priorities: ['routine'] }, period: 'day', limit: usd(0.05), softThresholds: [80], onLimit: { interactive: 'ask', background: 'defer' }, enabled: true }];
  const stores = openStores(tmpDb(), budgets);
  const gate = new BudgetGate({ store: stores.budgets, timeZone: 'UTC', clock: new ManualClock(Date.UTC(2026, 10, 8, 12)), safetyFactor: 1 });
  const results = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    const r = await gate.reserve({ requestId: `j${i}`, estimate: usd(0.004), priority: 'routine', providerId: 'p', route: 'memory.extract' });
    if (r.ok) await gate.settle(r.reservationId, usd(0.004));
    return r.ok;
  }));
  assert.equal(results.filter(Boolean).length, 12);
  const c = await stores.budgets.counter('bg', Date.UTC(2026, 10, 8));
  assert.ok(c.spent <= usd(0.05));
  assert.equal(c.reserved, 0);
  assert.equal(stores.budgets.activeReservationCount(), 0);
  stores.db.close();
});

test('memory search in SQLite: full-text, vectors, supersede and suppression', async () => {
  const stores = openStores(tmpDb());
  const t = createTestRouter();
  const memory = new MemoryService({ store: stores.memory, embedder: routerEmbedder(t.router, 'openai/embed-small'), clock: t.clock });
  const old = await memory.remember({ content: "The owner's sister is named Leila.", kind: 'relationship', entities: [{ name: 'Leila', kind: 'person' }] }, 'owner');
  await memory.supersede(old.id, { content: "The owner's sister is named Lina.", kind: 'relationship', entities: [{ name: 'Lina', kind: 'person' }] }, 'owner', 'correction');
  assert.match((await memory.search({ text: 'sisters name' }))[0]?.memory.content ?? '', /Lina/);
  assert.ok((await memory.search({ text: 'sister Leila', historical: true })).some((h) => h.memory.id === old.id));
  const party = await memory.remember({ content: 'The owner is planning a surprise party.', kind: 'event' }, 'owner');
  await memory.delete(party.id, { suppress: true }, 'owner');
  assert.equal(await stores.memory.get(party.id), undefined);
  assert.equal(await memory.isSuppressed('The owner is planning a surprise party.'), true);
  stores.db.close();
});

test('online backup produces a working copy while the database is open', async () => {
  const path = tmpDb();
  const stores = openStores(path);
  await stores.memory.setNotes('Prefers mornings.');
  const backup = join(mkdtempSync(join(tmpdir(), 'feroxes-backup-')), 'copy.db');
  stores.db.backupTo(backup);
  stores.db.close();
  const copy = openStores(backup);
  assert.equal(await copy.memory.getNotes(), 'Prefers mornings.');
  copy.db.close();
});
