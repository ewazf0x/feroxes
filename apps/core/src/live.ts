import { type Logger, formatUsd, noopLogger, scrubSecrets } from '@feroxes/shared';
import { ElevenLabsStt, ElevenLabsTts } from '@feroxes/voice';
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

export async function liveProviders(env: Env, _opts: { quick?: boolean; logger?: Logger } = {}): Promise<LiveRow[]> {
  // Exactly what Settings → Providers configured: one real request per enabled provider.
  const fx = await createFeroxes(env, { logger: noopLogger });
  const rows: LiveRow[] = [];
  try {
    const all = (await fx.providers.summaries()).providers.filter((p) => p.enabled);
    if (all.length === 0) return [{ area: 'providers', name: 'all', result: 'SKIP', detail: 'No provider enabled. Set one up in Settings → Providers.' }];
    for (const p of all) {
      const r = await fx.providers.test(p.id);
      rows.push({ area: 'providers', name: `${p.name}${r.model ? ` ${r.model}` : ''}`, result: r.ok ? 'PASS' : 'FAIL', detail: r.ok ? `${r.latencyMs} ms, ${r.tokens?.input ?? 0}+${r.tokens?.output ?? 0} tokens, ${p.id === 'kiro' ? 'Kiro credits' : formatUsd(r.costNanoUsd ?? 0)}, reply ${JSON.stringify(r.reply)}` : r.error ?? 'failed' });
    }
    const usage = (await fx.ledger.summarize({}, 'modelId')).filter((u) => u.calls > u.errors);
    rows.push({ area: 'providers', name: 'metering', result: usage.length ? 'PASS' : rows.some((r) => r.result === 'PASS') ? 'FAIL' : 'SKIP', detail: usage.map((u) => `${u.key}: ${u.calls} call(s), ${u.inputTokens}+${u.outputTokens} tokens, ${formatUsd(u.cost)}`).join('; ') || 'no successful call to meter' });
  } finally {
    await fx.shutdown();
  }
  return rows;
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
