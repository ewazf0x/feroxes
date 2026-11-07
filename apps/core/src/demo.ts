import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AdapterRequest, type LlmMessage, MockAdapter, type MockResponse, type ModelEntry } from '@feroxes/llm';
import { formatUsd, noopLogger } from '@feroxes/shared';
import { resolveCatalog } from './catalog.ts';
import { loadEnv } from './config.ts';
import { createFeroxes } from './container.ts';

/**
 * Keyless end-to-end demo: the real router, budgets, memory, policy gate, approvals, audit and
 * kill switch, with scripted mock providers standing in for Anthropic, OpenAI, Gemini, OpenRouter.
 */
const lastUser = (msgs: LlmMessage[]) => {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === 'user') return typeof m.content === 'string' ? m.content : '';
  }
  return '';
};

/** A tiny rule-based "model" so the demo behaves like a real assistant. */
function demoBrain({ request }: { model: ModelEntry; request: AdapterRequest }): MockResponse {
  const msgs = request.messages;
  const last = msgs.at(-1)!;
  const allText = msgs.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  if (request.output?.name === 'memory_candidates') return { steps: [{ kind: 'text', text: '{"candidates":[]}' }] };
  if (request.output) return { steps: [{ kind: 'text', text: '{"action":"add","reason":"demo"}' }] };
  if (last.role === 'tool') {
    if (last.toolName === 'memory__save') return { steps: [{ kind: 'text', text: "Saved. I'll remember that." }] };
    if (last.toolName === 'files__delete') return { steps: [{ kind: 'text', text: last.isError ? `I couldn't delete it: ${last.content}` : 'Done, the old notes file is gone.' }] };
    return { steps: [{ kind: 'text', text: `Result: ${last.content.slice(0, 200)}` }] };
  }
  const q = lastUser(msgs).toLowerCase();
  if (q.startsWith('remember')) {
    return { steps: [{ kind: 'tool', name: 'memory__save', args: { content: "The owner's sister is named Leila and lives in Lyon.", kind: 'relationship', people: ['Leila'], sensitivity: 'private', importance: 0.8 } }] };
  }
  if (q.includes('sister')) {
    const line = allText.split('\n').find((l) => /sister is named/i.test(l));
    const id = /\[m:([0-9a-f]{8})\]/.exec(line ?? '')?.[1];
    return { steps: [line ? { kind: 'text', text: `Your sister Leila lives in Lyon (m:${id}).`, chunks: 4 } : { kind: 'text', text: "I don't know yet." }] };
  }
  if (q.includes('delete')) return { steps: [{ kind: 'tool', name: 'files__delete', args: { path: 'notes/old.md' } }] };
  return { steps: [{ kind: 'text', text: 'Hello! I am the Feroxes demo brain.' }] };
}

function log(line = '') {
  process.stdout.write(`${line}\n`);
}

export async function runDemo() {
  const workspace = mkdtempSync(join(tmpdir(), 'feroxes-demo-'));
  mkdirSync(join(workspace, 'notes'));
  writeFileSync(join(workspace, 'notes', 'old.md'), 'old notes');
  const env = loadEnv({ ...process.env, FEROXES_WORKSPACE_DIR: workspace, ANTHROPIC_API_KEY: 'demo', OPENAI_API_KEY: 'demo', GEMINI_API_KEY: 'demo', OPENROUTER_API_KEY: 'demo', FEROXES_TIMEZONE: process.env.FEROXES_TIMEZONE ?? 'UTC' });
  const catalog = resolveCatalog(env);
  const adapters = new Map(catalog.providers.map((p) => [p.id, new MockAdapter({ fallback: demoBrain, embedDims: 256 })]));
  catalog.models.forEach((m) => {
    if (m.modality === 'embedding') m.dimensions = 256;
  });
  const fx = await createFeroxes(env, { adapters, catalog, logger: noopLogger });

  const chat = async (sessionId: string, text: string, tier: 'fast' | 'balanced' = 'balanced') => {
    log(`\n  owner  › ${text}`);
    process.stdout.write('  feroxes› ');
    const off = fx.events.subscribe('run.delta', (e) => process.stdout.write(e.payload.text));
    const offReset = fx.events.subscribe('run.reset', () => process.stdout.write(' ⟲ '));
    const { done } = await fx.runtime.sendMessage(sessionId, text, { tier });
    const run = await done;
    off();
    offReset();
    if (run.status === 'waiting_approval') process.stdout.write('(waiting for your approval)');
    else if (run.status !== 'completed') process.stdout.write(`(${run.status}: ${run.error ?? ''})`);
    else {
      const msgs = await fx.agentStore.messages(sessionId);
      const lastAssistant = msgs.at(-1);
      if (lastAssistant?.role === 'assistant' && !lastAssistant.content.length) process.stdout.write('(no text)');
    }
    log(`\n           [${run.modelId ?? '-'} · ${run.totals.steps} step(s) · ${formatUsd(run.totals.costNanoUsd)}]`);
    return run;
  };

  log('Feroxes demo — real router, budgets, memory, policy gate and audit; mock providers.\n');
  log('1. Memory: the owner asks Feroxes to remember something.');
  const s1 = await fx.runtime.createSession('cli');
  // Memory is private, so this conversation can't go to the free-tier Gemini key.
  await chat(s1.id, "Remember that my sister's name is Leila and she lives in Lyon.");

  log('\n2. A new conversation recalls it from long-term memory, with a citation id.');
  const s2 = await fx.runtime.createSession('cli');
  await chat(s2.id, 'Where does my sister live?');

  log('\n3. Failover: Anthropic returns HTTP 429; the request moves to OpenAI without the owner noticing.');
  adapters.get('anthropic')!.queue('anthropic/claude-sonnet-5.5', { steps: [{ kind: 'error', errorClass: 'rate_limited', status: 429, retryAfterMs: 30_000 }] });
  await chat(s2.id, 'Sorry, where did you say my sister lives?');
  const failover = (await fx.ledger.query({})).filter((e) => e.outcome === 'error').at(-1);
  if (failover) log(`           ledger: ${failover.modelId} → ${failover.errorClass}; model cooling down, next candidate answered`);

  log('\n4. Policy gate: deleting a file is destructive, so it waits for approval.');
  const r = await chat(s2.id, 'Delete my old notes file.');
  const [pending] = await fx.approvals.pending();
  if (r.status === 'waiting_approval' && pending) {
    log(`           approval card: "${pending.preview.title}" — ${pending.policyReason}`);
    log('           owner approves.');
    process.stdout.write('  feroxes› ');
    const off = fx.events.subscribe('run.delta', (e) => process.stdout.write(e.payload.text));
    const resumed = await fx.runtime.resolveApproval(pending.id, { approve: true });
    await resumed?.done;
    off();
    log('');
  }

  log('\n5. Kill switch: STOP blocks everything until the owner resumes.');
  await fx.system.stop('owner', 'demo');
  await chat(s2.id, 'Are you there?');
  await fx.system.resume('owner', 'demo over');
  await chat(s2.id, 'Hello again!', 'fast');

  log('\n6. Every call is in the ledger, priced at call time:');
  for (const row of await fx.ledger.summarize({}, 'modelId')) {
    log(`   ${row.key.padEnd(42)} ${String(row.calls).padStart(3)} calls  ${String(row.errors).padStart(2)} errors  ${formatUsd(row.cost).padStart(10)}`);
  }
  log('\n   Budgets:');
  for (const b of await fx.budget.status()) log(`   ${b.budget.name.padEnd(20)} ${formatUsd(b.counter.spent).padStart(10)} of ${formatUsd(b.budget.limit)}  (${b.percent.toFixed(3)}%)`);

  const verify = await fx.audit.verify();
  log(`\n7. Audit log: ${verify.ok ? `${verify.count} entries, hash chain intact (head ${verify.head.slice(0, 12)}…)` : `BROKEN at ${verify.brokenAtSeq}`}`);
  for (const e of await fx.audit.query({})) log(`   #${e.seq} ${e.action.padEnd(14)} ${e.decision.padEnd(8)} ${e.outcome.padEnd(8)} ${e.summary.slice(0, 70)}`);

  const memories = await fx.memory.store.list({ statuses: ['active'] });
  log(`\n8. Long-term memory now holds ${memories.length} active item(s):`);
  for (const m of memories) log(`   [m:${m.id.slice(-8)}] ${m.kind}: ${m.content} (${m.source}, sensitivity ${m.sensitivity})`);
  await fx.shutdown();
  log('\nDemo complete.');
}
