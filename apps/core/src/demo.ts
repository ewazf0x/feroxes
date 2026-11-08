import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeDesktop } from '@feroxes/devices';
import { type AdapterRequest, type LlmMessage, MockAdapter, type MockResponse, type ModelEntry } from '@feroxes/llm';
import { formatUsd, noopLogger } from '@feroxes/shared';
import { resolveCatalog } from './catalog.ts';
import { loadEnv } from './config.ts';
import { createFeroxes, type Feroxes } from './container.ts';

/**
 * Keyless end-to-end demo: the real router, budgets, SQLite storage, memory, brain, device hub,
 * voice pipeline, policy gate and audit — with scripted providers standing in for Anthropic,
 * OpenAI, Gemini, OpenRouter and ElevenLabs, and a simulated PC.
 */
const text = (m: LlmMessage) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join(' '));
const lastUser = (msgs: LlmMessage[]) => text([...msgs].reverse().find((m) => m.role === 'user') ?? { role: 'user', content: '' });
const reply = (t: string, chunks = 3): MockResponse => ({ steps: [{ kind: 'text', text: t, chunks }] });
const tool = (name: string, args: unknown): MockResponse => ({ steps: [{ kind: 'tool', name, args }] });

/** A tiny rule-based "model" so the demo behaves like a real assistant. */
function demoBrain({ request }: { model: ModelEntry; request: AdapterRequest }): MockResponse {
  const msgs = request.messages;
  const last = msgs.at(-1)!;
  const system = text(msgs[0] ?? { role: 'system', content: '' });
  const all = msgs.map(text).join('\n');
  if (request.output?.name === 'memory_candidates') return reply('{"candidates":[]}', 1);
  if (request.output) return reply('{"action":"add","reason":"demo"}', 1);
  if (system.includes('briefing as their personal assistant')) {
    const disk = /(\d+) GB free/.exec(lastUser(msgs))?.[1];
    return reply(`Good morning! Your PC is online${disk ? ` but only has ${disk} GB of disk left, so let's clear some space today` : ''}. Your goal "Ship the desktop app" is at 0%, so I'd start with the Windows build. Nothing is waiting for your approval.`);
  }
  if (last.role === 'tool') {
    const r = last.content;
    switch (last.toolName) {
      case 'memory__save':
        return reply("Saved. I'll remember that.");
      case 'desktop__ui_tree':
        return tool('desktop__act', { elementId: 'e1', action: 'set_value', value: 'Buy milk' });
      case 'desktop__act':
        return reply(last.isError ? `That didn't work: ${r}` : 'Done: I typed "Buy milk" into Notepad on your PC.');
      case 'why__explain':
        return reply(`Here is the trail:\n${r.split('\n').slice(0, 8).join('\n')}`, 1);
      default:
        return reply(`Result: ${r.slice(0, 200)}`);
    }
  }
  const q = lastUser(msgs).toLowerCase();
  if (q.startsWith('remember')) return tool('memory__save', { content: "The owner's sister is named Leila and lives in Lyon.", kind: 'relationship', people: ['Leila'], sensitivity: 'private', importance: 0.8 });
  if (q.includes('sister')) {
    const line = all.split('\n').find((l) => /sister is named/i.test(l));
    const id = /\[m:([0-9a-f]{8})\]/.exec(line ?? '')?.[1];
    return reply(line ? `Your sister Leila lives in Lyon (m:${id}).` : "I don't know yet.");
  }
  if (q.includes('notepad') && q.includes('write')) return tool('desktop__ui_tree', {});
  if (q.includes('notepad')) return reply('Your notepad says "Buy milk". Want me to add anything?');
  if (q.includes('why')) return tool('why__explain', {});
  return reply('Hello! I am the Feroxes demo brain.');
}

/** Fake ElevenLabs: Scribe returns a fixed transcript, TTS returns placeholder audio bytes. */
async function fakeElevenLabs(url: string, init: RequestInit): Promise<Response> {
  if (url.includes('/v1/speech-to-text')) return Response.json({ text: "What's on my notepad?", language_code: 'en', words: [{ end: 1.6 }] });
  const body = JSON.parse(String(init.body)) as { text: string };
  return new Response(new Uint8Array(body.text.length * 120)); // ~120 bytes of "audio" per character
}

function log(line = '') {
  process.stdout.write(`${line}\n`);
}

async function chat(fx: Feroxes, sessionId: string, message: string, tier: 'fast' | 'balanced' = 'balanced') {
  log(`\n  owner  › ${message}`);
  process.stdout.write('  feroxes› ');
  const off = fx.events.subscribe('run.delta', (e) => process.stdout.write(e.payload.text));
  const run = await (await fx.runtime.sendMessage(sessionId, message, { tier })).done;
  off();
  if (run.status === 'waiting_approval') process.stdout.write('(waiting for your approval)');
  else if (run.status !== 'completed') process.stdout.write(`(${run.status}: ${run.error ?? ''})`);
  log(`\n           [${run.modelId ?? '-'} · ${run.totals.steps} step(s) · ${formatUsd(run.totals.costNanoUsd)}]`);
  return run;
}

export async function runDemo() {
  const dir = mkdtempSync(join(tmpdir(), 'feroxes-demo-'));
  mkdirSync(join(dir, 'workspace'));
  writeFileSync(join(dir, 'workspace', 'notes.md'), 'old notes');
  const env = loadEnv({ ...process.env, FEROXES_DATA_DIR: join(dir, 'data'), FEROXES_WORKSPACE_DIR: join(dir, 'workspace'), ANTHROPIC_API_KEY: 'demo', OPENAI_API_KEY: 'demo', GEMINI_API_KEY: 'demo', OPENROUTER_API_KEY: 'demo', ELEVENLABS_API_KEY: 'demo', FEROXES_TIMEZONE: process.env.FEROXES_TIMEZONE ?? 'UTC', FEROXES_OWNER_NAME: 'Sam' });
  const boot = async () => {
    const catalog = resolveCatalog(env);
    catalog.models.forEach((m) => m.modality === 'embedding' && (m.dimensions = 256));
    const adapters = new Map(catalog.providers.map((p) => [p.id, new MockAdapter({ fallback: demoBrain, embedDims: 256 })]));
    return { fx: await createFeroxes(env, { adapters, catalog, logger: noopLogger, fetch: fakeElevenLabs as typeof fetch }), adapters };
  };

  log('Feroxes demo: the real Core (router, budgets, SQLite, memory, brain, devices, voice, policy, audit) with scripted AI providers and a simulated PC.\n');
  let { fx } = await boot();

  log('1. Memory: the owner asks Feroxes to remember something.');
  await chat(fx, (await fx.runtime.createSession('cli')).id, "Remember that my sister's name is Leila and she lives in Lyon.");
  await fx.shutdown();
  log('\n   … Feroxes is shut down and started again (same database file) …');
  ({ fx } = await boot());
  const self = fx.brain.self.get();
  log(`   Self-model v${self.version}: "${self.identity.name}", start #${self.identity.bootCount}, running since ${new Date(self.identity.firstBootAt).toISOString().slice(0, 10)}.`);

  log('\n2. After the restart, a new conversation still knows, and cites the memory.');
  const s = (await fx.runtime.createSession('cli')).id;
  await chat(fx, s, 'Where does my sister live?');

  log('\n3. PC control: the Feroxes desktop app (simulated here) pairs with a one-time code.');
  const pc = fakeDesktop('Sam-PC');
  await pc.device.connect(fx.hub, { code: fx.hub.createPairingCode().code });
  pc.device.heartbeat({ diskFreeGb: 6, cpuPercent: 14, memoryPercent: 48, network: 'ethernet' });
  log(`   Connected: ${fx.hub.online().map((d) => `${d.name} (${d.platform}, ${d.capabilities.length} capabilities)`).join(', ')}`);
  let run = await chat(fx, s, 'Write "Buy milk" in Notepad on my PC.');
  const [approval] = await fx.approvals.pending();
  if (run.status === 'waiting_approval' && approval) {
    log(`           approval card: "${approval.preview.title}" — ${approval.policyReason}`);
    log('           owner taps "Allow for this task".');
    process.stdout.write('  feroxes› ');
    const off = fx.events.subscribe('run.delta', (e) => process.stdout.write(e.payload.text));
    run = await (await fx.runtime.resolveApproval(approval.id, { approve: true, scope: 'task' }))!.done;
    off();
    log(`\n           [Notepad now contains: "${pc.state.text}"; commands were Ed25519-signed and verified by the device]`);
  }

  log('\n4. "Why did you do that?" — the full trail, rebuilt from stored data.');
  await chat(fx, s, 'Why did you do that?');

  log('\n5. Voice: push-to-talk → Scribe speech-to-text → agent → Flash text-to-speech, sentence by sentence.');
  let bytes = 0;
  let speaking = false;
  for await (const e of fx.voice!.pushToTalk({ sessionId: s, audio: new Uint8Array(32_000), mime: 'audio/webm', durationMs: 1600 })) {
    if (e.type === 'transcript') log(`  owner  🎙 "${e.text}"`);
    if (e.type === 'text') {
      if (!speaking) process.stdout.write('  feroxes🔊 ');
      speaking = true;
      process.stdout.write(e.text);
    }
    if (e.type === 'audio') bytes += e.chunk.length;
  }
  log(`\n           [${(bytes / 1024).toFixed(1)} KB of audio streamed; speech metered like tokens]`);

  log('\n6. Goals and the morning briefing (the brain runs this at 07:30 by itself).');
  fx.brain.goals.create({ title: 'Ship the desktop app', horizon: 'month', priority: 1, autonomy: 'suggest' }, 'owner');
  log(`   ${(await fx.brain.briefing('morning')).replace(/\n/g, '\n   ')}`);

  log('\n7. Kill switch: STOP blocks everything, on the Core and on the paired PC.');
  await fx.system.stop('owner', 'demo');
  await new Promise((r) => setTimeout(r, 5));
  await chat(fx, s, 'Are you there?');
  log(`           [PC app received halt: ${pc.device.halted}]`);
  await fx.system.resume('owner', 'demo over');

  log('\n8. Ledger and budgets (every model and voice call, priced at call time):');
  for (const row of await fx.ledger.summarize({}, 'modelId')) log(`   ${row.key.padEnd(42)} ${String(row.calls).padStart(3)} calls  ${formatUsd(row.cost).padStart(10)}`);
  for (const b of await fx.budget.status()) log(`   ${b.budget.name.padEnd(20)} ${formatUsd(b.counter.spent).padStart(10)} of ${formatUsd(b.budget.limit)}`);
  const v = await fx.audit.verify();
  log(`\n9. Audit log: ${v.ok ? `${v.count} entries, hash chain intact` : `BROKEN at ${v.brokenAtSeq}`}; database: ${join(env.FEROXES_DATA_DIR, 'feroxes.db')}`);
  await fx.shutdown();
  log('\nDemo complete.');
}
