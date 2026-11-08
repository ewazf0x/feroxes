import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Budget, BudgetGate, InMemoryBudgetStore, InMemoryUsageLedgerStore, PriceBook, UsageLedger } from '@feroxes/metering';
import { ManualClock, usd } from '@feroxes/shared';
import { AsyncQueue, type ConversationPort, ElevenLabsStt, ElevenLabsTts, SentenceChunker, VoiceService, isStopCommand, toSpeakable } from './index.ts';

// Seed prices (third-party summaries, checked at implementation time): Flash TTS $0.05 per 1k
// characters, Scribe STT $0.22 per audio hour.
const prices = new PriceBook([
  { id: 'tts', modelId: 'elevenlabs/eleven_flash_v2_5', effectiveFrom: 0, inputPerMTok: 0, outputPerMTok: 0, unitPrice: 0.05 / 1000 },
  { id: 'stt', modelId: 'elevenlabs/scribe_v2', effectiveFrom: 0, inputPerMTok: 0, outputPerMTok: 0, unitPrice: 0.22 / 3600 },
]);

function fakeElevenLabs() {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('/v1/speech-to-text')) return Response.json({ text: " What's on my calendar today? ", language_code: 'en', words: [{ end: 2.4 }] });
    const body = JSON.parse(String(init.body)) as { text: string };
    return new Response(new TextEncoder().encode(`MP3[${body.text}]`), { headers: { 'content-type': 'audio/mpeg' } });
  };
  return { f, calls };
}

function port(answer: string[], status = 'completed') {
  const sent: string[] = [];
  let stopped = '';
  const p: ConversationPort = {
    async send(_sessionId, text) {
      sent.push(text);
      const q = new AsyncQueue<string>();
      queueMicrotask(() => {
        answer.forEach((d) => q.push(d));
        q.close();
      });
      return { runId: 'run-1', deltas: q, done: Promise.resolve({ status, ...(status === 'waiting_approval' ? { approvalTitle: 'Send email to Leila' } : {}) }) };
    },
    async stop(reason) {
      stopped = reason;
    },
  };
  return { p, sent, stopped: () => stopped };
}

function setup(budgetUsd = 1) {
  const clock = new ManualClock(Date.UTC(2026, 10, 8, 8));
  const budgets: Budget[] = [{ id: 'g', name: 'Global daily', scope: { type: 'global' }, period: 'day', limit: usd(budgetUsd), softThresholds: [], onLimit: { interactive: 'ask', background: 'defer' }, enabled: true }];
  const ledgerStore = new InMemoryUsageLedgerStore();
  const ledger = new UsageLedger({ store: ledgerStore, prices, clock });
  const budget = new BudgetGate({ store: new InMemoryBudgetStore(budgets), timeZone: 'UTC', clock, safetyFactor: 1 });
  const el = fakeElevenLabs();
  const stt = new ElevenLabsStt({ apiKey: 'xi-key', fetch: el.f });
  const tts = new ElevenLabsTts({ apiKey: 'xi-key', voiceId: 'voice123', fetch: el.f });
  return { clock, ledgerStore, ledger, budget, el, stt, tts };
}

test('speakable text: no markdown, code, links or memory ids', () => {
  assert.equal(toSpeakable('**Your sister** Leila lives in Lyon (m:1a2b3c4d). See [the map](https://maps.example/x).'), 'Your sister Leila lives in Lyon. See the map.');
  assert.equal(toSpeakable('Run this:\n```bash\nrm -rf /\n```\n- one\n- two'), 'Run this: I put the code in the chat. one two');
});

test('sentence chunker releases sentences as they stream in', () => {
  const c = new SentenceChunker();
  assert.deepEqual(c.push('You have two meet'), []);
  assert.deepEqual(c.push('ings today. The first is at 10'), ['You have two meetings today.']);
  assert.deepEqual(c.push('.30 with Sam. '), ['The first is at 10.30 with Sam.']);
  assert.equal(c.flush(), undefined);
  const long = new SentenceChunker({ maxChars: 40 });
  assert.ok(long.push('This sentence keeps going and going, with no end in sight and more words').length >= 1);
});

test('push-to-talk: transcript, streamed answer, speech per sentence, all metered', async () => {
  const s = setup();
  const conv = port(['You have two meetings today', '. The first one is at ten with Sam.', ' Want a reminder?']);
  const voice = new VoiceService({ stt: s.stt, tts: s.tts, port: conv.p, budget: s.budget, ledger: s.ledger, prices, clock: s.clock });
  const events = [];
  for await (const e of voice.pushToTalk({ sessionId: 's1', audio: new Uint8Array([1, 2, 3]), mime: 'audio/webm', durationMs: 2400 })) events.push(e);

  assert.deepEqual(events[0], { type: 'transcript', text: "What's on my calendar today?", language: 'en' });
  assert.deepEqual(conv.sent, ["What's on my calendar today?"]);
  const audio = events.filter((e) => e.type === 'audio').map((e) => new TextDecoder().decode((e as { chunk: Uint8Array }).chunk));
  assert.deepEqual(audio, ['MP3[You have two meetings today.]', 'MP3[The first one is at ten with Sam.]', 'MP3[Want a reminder?]']);
  assert.deepEqual(events.at(-1), { type: 'done', runId: 'run-1', status: 'completed' });

  const ttsCalls = s.el.calls.filter((c) => c.url.includes('text-to-speech'));
  assert.equal(ttsCalls[0]!.url, 'https://api.elevenlabs.io/v1/text-to-speech/voice123/stream?output_format=mp3_44100_128');
  assert.equal((ttsCalls[0]!.init.headers as Record<string, string>)['xi-api-key'], 'xi-key');
  assert.equal(JSON.parse(String(ttsCalls[1]!.init.body)).previous_text, 'You have two meetings today.');
  const form = s.el.calls[0]!.init.body as FormData;
  assert.equal(form.get('model_id'), 'scribe_v2');
  assert.ok(form.get('file') instanceof Blob);

  const stt = s.ledgerStore.events.find((e) => e.route === 'voice.stt')!;
  assert.equal(stt.usage.units, 3);
  assert.equal(stt.cost, Math.round(3 * (0.22 / 3600) * 1e9));
  const ttsCost = s.ledgerStore.events.filter((e) => e.route === 'voice.tts').reduce((n, e) => n + e.cost, 0);
  const chars = ['You have two meetings today.', 'The first one is at ten with Sam.', 'Want a reminder?'].join('').length;
  assert.equal(ttsCost, usd(chars * 0.00005));
});

test('"Feroxes, stop" by voice triggers the kill switch instead of a chat turn', async () => {
  assert.ok(isStopCommand('Feroxes, stop!'));
  assert.ok(isStopCommand('stop everything'));
  assert.ok(!isStopCommand("don't stop the music"));
  const s = setup();
  const conv = port([]);
  const stopSaid: ConversationPort['send'] = conv.p.send;
  const stt = { providerId: 'elevenlabs', modelId: 'elevenlabs/scribe_v2', transcribe: async () => ({ text: 'Feroxes, stop.' }) };
  const voice = new VoiceService({ stt, tts: s.tts, port: { ...conv.p, send: stopSaid }, budget: s.budget, ledger: s.ledger, prices, clock: s.clock });
  const events = [];
  for await (const e of voice.pushToTalk({ sessionId: 's1', audio: new Uint8Array([1]), mime: 'audio/webm', durationMs: 900 })) events.push(e.type);
  assert.equal(conv.stopped(), 'voice command');
  assert.deepEqual(conv.sent, []);
  assert.deepEqual(events, ['transcript', 'stopped', 'audio', 'done']);
});

test('when the budget runs out mid-answer, Feroxes keeps answering in text', async () => {
  const s = setup(0.0025); // enough for the transcript and the first sentence of speech
  const conv = port(['First sentence is spoken aloud here. ', 'Second sentence is long enough that the budget runs dry before it can be spoken at all.']);
  const voice = new VoiceService({ stt: s.stt, tts: s.tts, port: conv.p, budget: s.budget, ledger: s.ledger, prices, clock: s.clock });
  const types: string[] = [];
  let notice = '';
  for await (const e of voice.pushToTalk({ sessionId: 's1', audio: new Uint8Array([1]), mime: 'audio/webm', durationMs: 1000 })) {
    types.push(e.type);
    if (e.type === 'notice') notice = e.message;
  }
  assert.ok(types.includes('audio') && types.includes('notice') && types.at(-1) === 'done', types.join(','));
  assert.match(notice, /text only/);
});

test('approval needed: the voice reply says so', async () => {
  const s = setup();
  const conv = port(['Drafting the email now.'], 'waiting_approval');
  const voice = new VoiceService({ stt: s.stt, tts: s.tts, port: conv.p, budget: s.budget, ledger: s.ledger, prices, clock: s.clock });
  const spoken: string[] = [];
  for await (const e of voice.pushToTalk({ sessionId: 's1', audio: new Uint8Array([1]), mime: 'audio/webm', durationMs: 1000 })) if (e.type === 'audio') spoken.push(new TextDecoder().decode(e.chunk));
  assert.match(spoken.at(-1) ?? '', /approval first: Send email to Leila/);
});
