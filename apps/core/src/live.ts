import { type ModelEntry, type ProviderAdapter, createAdapter } from '@feroxes/llm';
import { type Logger, formatUsd, noopLogger, scrubSecrets } from '@feroxes/shared';
import { ElevenLabsStt, ElevenLabsTts } from '@feroxes/voice';
import { resolveCatalog } from './catalog.ts';
import type { Env } from './config.ts';
import { createFeroxes } from './container.ts';

/**
 * Live verification with the owner's real credentials (`feroxes live …`). Nothing here runs in the
 * test suite or CI: it spends real (tiny) amounts and talks to real accounts.
 *
 * providers  one real request per configured chat model (or one per provider with --quick):
 *            answer, token usage, ledger entry, cost; then a deliberate auth failure that must fall
 *            back to a working model; then a budget too small for any call, which must refuse
 *            before a request is sent. Runs on an in-memory database: your ledger isn't touched.
 * voice      ElevenLabs: speak a sentence (TTS), transcribe that audio back (STT), compare.
 * connectors every connected account: health check, then each read-only "live-safe" action.
 */
export type LiveRow = { area: string; name: string; result: 'PASS' | 'FAIL' | 'SKIP'; detail: string };

const PROMPT = 'Reply with exactly this text and nothing else: FEROXES-OK';

export async function liveProviders(env: Env, opts: { quick?: boolean; logger?: Logger } = {}): Promise<LiveRow[]> {
  const rows: LiveRow[] = [];
  const resolved = resolveCatalog(env);
  if (resolved.providers.length === 0) return [{ area: 'providers', name: 'all', result: 'SKIP', detail: 'No provider configured (set API keys in .env, or enable Kiro).' }];

  const chat = resolved.models.filter((m) => m.modality === 'chat');
  const targets = opts.quick ? resolved.providers.map((p) => chat.find((m) => m.providerId === p.id)).filter((m): m is ModelEntry => !!m) : chat;
  const keys = [...resolved.keys.values()];

  // A provider with a deliberately wrong key, to prove failover to a working model.
  const realFirst = targets.find((m) => m.providerId !== 'kiro');
  const realProvider = realFirst ? resolved.providers.find((p) => p.id === realFirst.providerId) : undefined;
  if (realFirst && realProvider) {
    resolved.providers.push({ ...realProvider, id: 'live-bad', name: `${realProvider.name} (wrong key, on purpose)` });
    resolved.keys.set('live-bad', 'sk-feroxes-live-test-invalid-key-000000000000');
    resolved.models.push({ ...realFirst, id: `live-bad/${realFirst.modelKey}`, providerId: 'live-bad' });
  }
  resolved.routes.push(...targets.map((m, i) => ({ id: `live.model.${i}`, tier: m.tier, requiredCapabilities: [], defaultPriority: 'interactive' as const, allowEscalation: false, candidates: [m.id], maxOutputTokens: 20 })));
  if (realFirst) resolved.routes.push({ id: 'live.fallback', tier: realFirst.tier, requiredCapabilities: [], defaultPriority: 'interactive', allowEscalation: false, candidates: [`live-bad/${realFirst.modelKey}`, realFirst.id], maxOutputTokens: 20 });
  const adapters = new Map<string, ProviderAdapter>(resolved.providers.map((p) => [p.id, createAdapter(p, resolved.keys.get(p.id))]));
  const fx = await createFeroxes(env, { dbPath: ':memory:', catalog: resolved, adapters, logger: opts.logger ?? noopLogger });
  const ask = (route: string) => fx.router.generate({ route, messages: [{ role: 'user', content: PROMPT }], maxOutputTokens: 20, sensitivity: 'normal', priority: 'interactive', attribution: { taskType: 'live.test' } });
  try {
    for (const [i, m] of targets.entries()) {
      const started = Date.now();
      try {
        const r = await ask(`live.model.${i}`);
        const ok = /FEROXES-OK/i.test(r.text);
        const metered = m.providerId === 'kiro' || (r.finish.usage.inputTokens > 0 && r.finish.usageEventIds.length > 0);
        rows.push({ area: 'providers', name: m.id, result: ok && metered ? 'PASS' : 'FAIL', detail: `${Date.now() - started} ms, ${r.finish.usage.inputTokens}+${r.finish.usage.outputTokens} tokens, ${m.providerId === 'kiro' ? 'Kiro credits (not metered in $)' : formatUsd(r.finish.costNanoUsd)}${ok ? '' : `, unexpected answer: ${JSON.stringify(r.text.slice(0, 80))}`}${metered ? '' : ', NOT metered'}` });
      } catch (error) {
        rows.push({ area: 'providers', name: m.id, result: 'FAIL', detail: scrubSecrets((error as Error).message, keys).slice(0, 300) });
      }
    }
    if (realFirst) {
      try {
        const r = await ask('live.fallback');
        const failed = r.finish.attempts.filter((a) => a.modelId.startsWith('live-bad/'));
        rows.push({ area: 'providers', name: 'fallback', result: r.finish.modelId === realFirst.id && failed.length > 0 ? 'PASS' : 'FAIL', detail: `wrong key → ${failed.map((a) => a.errorClass ?? a.outcome).join(', ') || 'no failed attempt recorded'} → answered by ${r.finish.modelId}` });
      } catch (error) {
        rows.push({ area: 'providers', name: 'fallback', result: 'FAIL', detail: scrubSecrets((error as Error).message, keys).slice(0, 300) });
      }
    }
    const usage = await fx.ledger.summarize({}, 'modelId');
    const live = usage.filter((u) => !u.key.startsWith('live-bad'));
    // Every model that answered must have a ledger row with real token counts (Kiro: call counts only).
    const answered = live.filter((u) => u.calls > u.errors);
    const meteredOk = answered.length > 0 && answered.every((u) => u.key.startsWith('kiro/') || u.inputTokens > 0);
    rows.push({ area: 'providers', name: 'metering', result: meteredOk ? 'PASS' : 'FAIL', detail: live.map((u) => `${u.key}: ${u.calls} call(s) (${u.errors} failed), ${u.inputTokens}+${u.outputTokens} tokens, ${formatUsd(u.cost)}`).join('; ') || 'no ledger rows' });
  } finally {
    await fx.shutdown();
  }

  // Spending limit: a daily budget far below the cost of any call must stop it before it is sent.
  const paid = targets.find((m) => m.providerId !== 'kiro');
  if (paid) {
    const tiny = await createFeroxes({ ...env, FEROXES_DAILY_BUDGET_USD: 1e-9, FEROXES_MONTHLY_BUDGET_USD: 1e-9 }, { dbPath: ':memory:', catalog: resolveCatalogWith(env, paid), logger: noopLogger });
    const hosts = new Set<string>();
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => (hosts.add(new URL(input instanceof Request ? input.url : String(input)).host), realFetch(input, init))) as typeof fetch;
    try {
      await tiny.router.generate({ route: 'live.limit', messages: [{ role: 'user', content: PROMPT }], maxOutputTokens: 20, sensitivity: 'normal', priority: 'interactive', attribution: { taskType: 'live.test' } });
      rows.push({ area: 'providers', name: 'spending limit', result: 'FAIL', detail: 'a call went through a $0.000000001 daily budget' });
    } catch (error) {
      rows.push({ area: 'providers', name: 'spending limit', result: hosts.size === 0 ? 'PASS' : 'FAIL', detail: `${scrubSecrets((error as Error).message, keys).slice(0, 160)}${hosts.size ? ` (but requests reached ${[...hosts].join(', ')})` : ' — refused before any request was sent'}` });
    } finally {
      globalThis.fetch = realFetch;
      await tiny.shutdown();
    }
  }
  return rows;
}

function resolveCatalogWith(env: Env, model: ModelEntry) {
  const r = resolveCatalog(env);
  r.routes.push({ id: 'live.limit', tier: model.tier, requiredCapabilities: [], defaultPriority: 'interactive', allowEscalation: false, candidates: [model.id], maxOutputTokens: 20 });
  return r;
}

export async function liveVoice(env: Env): Promise<LiveRow[]> {
  if (!env.ELEVENLABS_API_KEY) return [{ area: 'voice', name: 'ElevenLabs', result: 'SKIP', detail: 'ELEVENLABS_API_KEY is not set.' }];
  const rows: LiveRow[] = [];
  const sentence = 'Feroxes voice check: the quick brown fox.';
  const tts = new ElevenLabsTts({ apiKey: env.ELEVENLABS_API_KEY, voiceId: env.ELEVENLABS_VOICE_ID, model: env.ELEVENLABS_TTS_MODEL });
  const stt = new ElevenLabsStt({ apiKey: env.ELEVENLABS_API_KEY, model: env.ELEVENLABS_STT_MODEL });
  let audio = new Uint8Array();
  try {
    const t0 = Date.now();
    let firstChunkMs = 0;
    const chunks: Uint8Array[] = [];
    for await (const c of tts.stream(sentence)) {
      if (!firstChunkMs) firstChunkMs = Date.now() - t0;
      chunks.push(c);
    }
    audio = Buffer.concat(chunks);
    const mp3 = audio.length > 1000 && ((audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33) || (audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0));
    rows.push({ area: 'voice', name: `TTS ${env.ELEVENLABS_TTS_MODEL}`, result: mp3 ? 'PASS' : 'FAIL', detail: `${Math.round(audio.length / 1024)} KB audio, first chunk after ${firstChunkMs} ms${mp3 ? '' : ', not MP3'}` });
  } catch (error) {
    rows.push({ area: 'voice', name: `TTS ${env.ELEVENLABS_TTS_MODEL}`, result: 'FAIL', detail: scrubSecrets((error as Error).message, [env.ELEVENLABS_API_KEY]) });
  }
  if (audio.length > 1000) {
    try {
      const t = await stt.transcribe(audio, { mime: 'audio/mpeg' });
      const heard = t.text.toLowerCase();
      const ok = heard.includes('voice check') && heard.includes('fox');
      rows.push({ area: 'voice', name: `STT ${env.ELEVENLABS_STT_MODEL}`, result: ok ? 'PASS' : 'FAIL', detail: `heard "${t.text.trim().slice(0, 80)}"` });
    } catch (error) {
      rows.push({ area: 'voice', name: `STT ${env.ELEVENLABS_STT_MODEL}`, result: 'FAIL', detail: scrubSecrets((error as Error).message, [env.ELEVENLABS_API_KEY]) });
    }
  }
  return rows;
}

export async function liveConnectors(env: Env): Promise<LiveRow[]> {
  const fx = await createFeroxes(env, { logger: noopLogger });
  const rows: LiveRow[] = [];
  try {
    const conns = fx.connectors.connections();
    if (conns.length === 0) return [{ area: 'connectors', name: 'all', result: 'SKIP', detail: 'No accounts connected yet (Integrations in the app).' }];
    const tools = new Map(fx.connectors.tools().map((t) => [t.name, t]));
    for (const conn of conns) {
      const c = fx.connectors.connector(conn.connectorId);
      const checked = await fx.connectors.check(conn.id);
      rows.push({ area: 'connectors', name: `${c.name} ${conn.accountName}`, result: checked.status === 'connected' ? 'PASS' : 'FAIL', detail: checked.status === 'connected' ? 'credentials valid' : `${checked.status}: ${checked.lastError ?? ''}` });
      if (checked.status !== 'connected') continue;
      for (const a of c.actions.filter((x) => x.liveSafe && x.category === 'read')) {
        if (!checked.enabledCapabilities.includes(a.capability)) {
          rows.push({ area: 'connectors', name: a.name, result: 'SKIP', detail: `capability "${a.capability}" is off` });
          continue;
        }
        try {
          const tool = tools.get(a.name)!;
          const input = a.input.parse({});
          const r = await tool.execute({ ...input, account: conn.id }, { runId: 'live', callId: 'live', idempotencyKey: `live:${a.name}`, signal: AbortSignal.timeout(60_000), taint: new (await import('@feroxes/policy')).TaintSet(), log: noopLogger, timeZone: env.FEROXES_TIMEZONE, progress() {} });
          rows.push({ area: 'connectors', name: a.name, result: 'PASS', detail: r.content.replace(/<\/?untrusted[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) });
        } catch (error) {
          rows.push({ area: 'connectors', name: a.name, result: 'FAIL', detail: (error as Error).message.slice(0, 200) });
        }
      }
    }
  } finally {
    await fx.shutdown();
  }
  return rows;
}

export function formatRows(rows: LiveRow[]): string {
  const w = Math.min(44, Math.max(...rows.map((r) => r.name.length)));
  return rows.map((r) => `${r.result.padEnd(4)}  ${r.area.padEnd(10)} ${r.name.padEnd(w)}  ${r.detail}`).join('\n');
}
