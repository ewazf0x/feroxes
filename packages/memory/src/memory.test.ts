import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestRouter, type MockResponse } from '@feroxes/llm';
import { DAY } from '@feroxes/shared';
import {
  ConsolidationService,
  ExtractionService,
  InMemoryMemoryStore,
  MemoryService,
  SecretRejectedError,
  type TranscriptMessage,
  containsSecret,
  exportJsonl,
  routerEmbedder,
} from './index.ts';

function setup() {
  const t = createTestRouter();
  const store = new InMemoryMemoryStore();
  const memory = new MemoryService({ store, embedder: routerEmbedder(t.router, 'openai/embed-small'), clock: t.clock });
  const extraction = new ExtractionService({ router: t.router, memory, clock: t.clock });
  const consolidation = new ConsolidationService({ router: t.router, memory, clock: t.clock });
  // The fast tier's first model answers extraction and reconciliation calls.
  const fast = (...responses: MockResponse[]) => t.adapter('anthropic').queue('anthropic/haiku', ...responses);
  return { t, store, memory, extraction, consolidation, fast };
}

const json = (value: unknown): MockResponse => ({ steps: [{ kind: 'text', text: JSON.stringify(value) }] });

const candidate = (content: string, extra: Record<string, unknown> = {}) => ({
  kind: 'relationship', content, entities: [{ name: 'Leila', kind: 'person' }], importance: 0.8, confidence: 0.9, owner_asserted: true, sensitivity: 'private', evidence_message_ids: ['m1'], ...extra,
});

const msg = (id: string, role: 'user' | 'assistant', content: string, createdAt = Date.UTC(2026, 10, 7, 12)): TranscriptMessage => ({ id, role, content, createdAt });

test('"remember" is stored as an owner-stated fact and found from a different phrasing', async () => {
  const { memory } = setup();
  await memory.remember({ content: "The owner's sister is named Leila.", kind: 'relationship', entities: [{ name: 'Leila', kind: 'person' }], sensitivity: 'private' }, 'owner');
  await memory.remember({ content: 'The owner prefers short answers.', kind: 'preference' }, 'owner');
  const hits = await memory.search({ text: "what's my sister called?" });
  assert.match(hits[0]?.memory.content ?? '', /Leila/);
  assert.equal(hits[0]?.memory.source, 'owner_asserted');
  assert.equal(hits[0]?.memory.confidence, 1);
  assert.ok(hits[0]!.breakdown.ranks.vector || hits[0]!.breakdown.ranks.text);
});

test('an owner correction supersedes the old fact, which stays in history', async () => {
  const { memory, extraction, fast } = setup();
  const old = await memory.remember({ content: "The owner's sister is named Leila.", kind: 'relationship', entities: [{ name: 'Leila', kind: 'person' }] }, 'owner');
  fast(
    json({ candidates: [candidate("The owner's sister is named Lina, not Leila.", { entities: [{ name: 'Lina', kind: 'person' }, { name: 'Leila', kind: 'person' }] })] }),
    json({ action: 'supersede', target_id: old.id, reason: 'owner corrected the name' }),
  );
  const report = await extraction.process({ sessionId: 's1', messages: [msg('m1', 'user', 'Actually, her name is Lina, not Leila.')] });
  assert.equal(report.superseded.length, 1, JSON.stringify(report));

  const current = await memory.search({ text: 'sister name' });
  assert.match(current[0]?.memory.content ?? '', /Lina/);
  assert.ok(!current.some((h) => h.memory.id === old.id), 'superseded fact is not retrieved by default');
  const historical = await memory.search({ text: 'sister name Leila', historical: true });
  assert.ok(historical.some((h) => h.memory.id === old.id));

  const detail = await memory.get(old.id);
  assert.equal(detail?.memory.status, 'superseded');
  assert.ok(detail?.memory.validTo);
  assert.deepEqual(detail?.events.map((e) => e.type), ['created', 'superseded']);
});

test('delete with suppression: the fact is gone and is not re-learned from old conversations', async () => {
  const { memory, extraction, fast, store } = setup();
  const m = await memory.remember({ content: 'The owner is planning a surprise party for Sam.', kind: 'event' }, 'owner');
  await memory.delete(m.id, { suppress: true }, 'owner');
  assert.equal(await store.get(m.id), undefined);
  const history = await memory.history(m.id);
  assert.ok(history.every((e) => e.before === undefined && e.after === undefined), 'history keeps only tombstones');

  fast(json({ candidates: [{ kind: 'event', content: 'The owner is planning a surprise party for Sam.', entities: [], importance: 0.6, confidence: 0.8, owner_asserted: false, evidence_message_ids: ['m1'] }] }));
  const report = await extraction.process({ sessionId: 's2', messages: [msg('m1', 'user', 'remember the party for Sam?')] });
  assert.equal(report.added.length, 0);
  assert.equal(report.dropped[0]?.reason, 'owner asked to forget this');
  await assert.rejects(memory.delete('x', { suppress: false }, 'agent'), /Only the owner/);
});

test('an inferred guess never overrides what the owner stated; it is flagged for review', async () => {
  const { memory, extraction, fast } = setup();
  const stated = await memory.remember({ content: 'The owner works at Acme Corp.', kind: 'fact', entities: [{ name: 'Acme Corp', kind: 'org' }] }, 'owner');
  fast(
    json({ candidates: [{ kind: 'fact', content: 'The owner probably works at Globex instead of Acme Corp.', entities: [{ name: 'Acme Corp', kind: 'org' }, { name: 'Globex', kind: 'org' }], importance: 0.5, confidence: 0.6, owner_asserted: false, evidence_message_ids: [] }] }),
    json({ action: 'supersede', target_id: stated.id, reason: 'seems to have changed jobs' }),
  );
  const report = await extraction.process({ sessionId: 's3', messages: [msg('m9', 'assistant', 'You mentioned a Globex badge earlier.'), msg('m10', 'user', 'ha, yes')] });
  assert.equal(report.flagged.length, 1, JSON.stringify(report));
  assert.equal((await memory.get(stated.id))?.memory.status, 'active');
  const flagged = (await memory.get(report.flagged[0]!))!.memory;
  assert.equal(flagged.status, 'archived');
  assert.equal(flagged.structured?.needsReview, true);
});

test('the same fact seen again adds evidence without a model call', async () => {
  const { memory, extraction, fast, t } = setup();
  const m = await memory.remember({ content: 'The owner drinks oat milk.', kind: 'preference', source: 'extracted', confidence: 0.6 }, 'extractor');
  fast(json({ candidates: [{ kind: 'preference', content: 'The owner drinks oat milk.', entities: [], importance: 0.4, confidence: 0.7, owner_asserted: false, evidence_message_ids: ['m1'] }] }));
  const calls = t.adapter('anthropic').calls.length;
  const report = await extraction.process({ sessionId: 's4', messages: [msg('m1', 'user', 'oat milk latte please')] });
  assert.deepEqual(report.evidence, [m.id]);
  assert.equal(t.adapter('anthropic').calls.length, calls + 1, 'only the extraction call; reconciliation skipped');
  const after = (await memory.get(m.id))!.memory;
  assert.equal(after.evidenceCount, 2);
  assert.ok(after.confidence > 0.6 && after.confidence <= 0.95);
});

test('malformed JSON from the model is retried once with the validation error', async () => {
  const { extraction, fast } = setup();
  fast({ steps: [{ kind: 'text', text: 'Sure! Here you go: {"candidates": [{"kind": "fact"}]}' }] }, json({ candidates: [] }));
  const report = await extraction.process({ sessionId: 's5', messages: [msg('m1', 'user', 'nothing much')] });
  assert.equal(report.candidates, 0);
  assert.equal(report.dropped.length, 0);
});

test('credentials are refused everywhere', async () => {
  const { memory, extraction, fast } = setup();
  assert.ok(containsSecret('my api key is sk-proj-abcdefghijklmnopqrstuvwx'));
  assert.ok(containsSecret('password: hunter22'));
  assert.ok(!containsSecret('The owner likes long walks on the beach.'));
  await assert.rejects(memory.remember({ content: 'My bank PIN is 4412', kind: 'fact' }, 'owner'), SecretRejectedError);
  fast(json({ candidates: [{ kind: 'fact', content: 'The owner uses the password: Tr0ub4dor&3 for email', entities: [], importance: 0.9, confidence: 1, owner_asserted: true, evidence_message_ids: [] }] }));
  const report = await extraction.process({ sessionId: 's6', messages: [msg('m1', 'user', 'my email password is Tr0ub4dor&3')] });
  assert.equal(report.added.length, 0);
  assert.equal(report.dropped[0]?.reason, 'looks like a credential');
});

test('sensitivity: private and secret memories stay out of contexts for providers that may not see them', async () => {
  const { memory } = setup();
  await memory.remember({ content: 'The owner has a dentist appointment on Friday.', kind: 'commitment', sensitivity: 'private', importance: 0.8 }, 'owner');
  await memory.remember({ content: 'The owner likes the dentist office playlist.', kind: 'preference', sensitivity: 'normal' }, 'owner');
  const normal = await memory.buildContext({ query: 'dentist', maxSensitivity: 'normal' });
  assert.ok(!normal.rendered.includes('appointment') && !normal.core.includes('appointment'));
  assert.ok(normal.rendered.includes('playlist') || normal.core.includes('playlist'));
  const priv = await memory.buildContext({ query: 'dentist', maxSensitivity: 'private' });
  assert.ok(priv.rendered.includes('appointment') || priv.core.includes('appointment'));
});

test('context block cites memory ids and keeps rules in the core block', async () => {
  const { memory } = setup();
  await memory.remember({ content: 'Always answer in English unless the owner writes in French.', kind: 'rule' }, 'owner');
  const trip = await memory.remember({ content: 'The owner is flying to Lisbon on 12 December.', kind: 'event', occurredAt: Date.UTC(2026, 11, 12), importance: 0.4 }, 'owner');
  const ctx = await memory.buildContext({ query: 'when is my Lisbon flight?', maxSensitivity: 'private' });
  assert.match(ctx.core, /Standing rules:\n- Always answer in English/);
  assert.ok(ctx.rendered.includes(`[m:${trip.id.slice(-8)}]`));
  assert.deepEqual(ctx.usedIds, [trip.id]);
});

test('undo restores the previous version; edits by the owner become owner-stated', async () => {
  const { memory } = setup();
  const m = await memory.remember({ content: 'The owner runs on Tuesdays.', kind: 'fact', source: 'extracted', confidence: 0.6 }, 'extractor');
  const edited = await memory.update(m.id, { content: 'The owner runs on Tuesdays and Thursdays.' }, 'owner', 'owner edit');
  assert.equal(edited.source, 'owner_asserted');
  assert.equal(edited.version, 2);
  const event = (await memory.history(m.id)).find((e) => e.type === 'updated')!;
  const undone = await memory.undo(event.id, 'owner');
  assert.equal(undone.content, 'The owner runs on Tuesdays.');
  assert.equal(undone.source, 'extracted');
  assert.equal((await memory.search({ text: 'when does the owner run' }))[0]?.memory.content, 'The owner runs on Tuesdays.');
});

test('consolidation: session episode, duplicate merge, core block; nothing raw is deleted', async () => {
  const { memory, consolidation, store, t } = setup();
  t.adapter('anthropic').queue('anthropic/haiku', { steps: [{ kind: 'text', text: 'Planning the Lisbon trip\n\nThe owner and Feroxes planned a December trip to Lisbon and chose flights.' }] });
  const episode = await consolidation.summarizeSession({ sessionId: 'sess-1', messages: [msg('a', 'user', 'help me plan Lisbon'), msg('b', 'assistant', 'Sure, when?'), msg('c', 'user', 'mid December')] });
  assert.equal(episode?.kind, 'conversation');
  assert.equal(episode?.title, 'Planning the Lisbon trip');
  assert.equal((await store.sources(episode!.id)).filter((s) => s.sourceType === 'message').length, 3);

  const a = await memory.remember({ content: 'The owner is allergic to peanuts.', kind: 'fact', importance: 0.9 }, 'owner');
  const b = await memory.remember({ content: 'The owner is allergic to peanuts!', kind: 'fact', source: 'extracted', confidence: 0.7 }, 'extractor');
  const before = (await store.list({})).length;
  const report = await consolidation.nightly();
  assert.deepEqual(report.merged, [{ survivor: a.id, merged: [b.id] }]);
  assert.equal((await store.get(b.id))?.status, 'merged');
  assert.equal((await store.list({})).length, before, 'merge keeps every row');
  const core = await store.latestCore();
  assert.match(core?.content ?? '', /peanuts/);

  t.clock.advance(400 * DAY);
  assert.ok((await memory.search({ text: 'peanuts' })).length > 0, 'facts decay slowly; still retrievable a year later');
});

test('export produces one JSON object per line, including history', async () => {
  const { memory, store } = setup();
  await memory.remember({ content: 'The owner speaks Arabic and English.', kind: 'fact' }, 'owner');
  const lines: string[] = [];
  for await (const line of exportJsonl(store)) lines.push(line);
  const parsed = lines.map((l) => JSON.parse(l));
  assert.equal(parsed[0].type, 'header');
  assert.equal(parsed[1].type, 'memory');
  assert.equal(parsed[1].history[0].type, 'created');
});
