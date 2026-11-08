import type { BudgetGate, PriceBook, UsageLedger } from '@feroxes/metering';
import { type Clock, FeroxesError, type PriorityClass, systemClock, uuidv7 } from '@feroxes/shared';
import type { SpeechToText, TextToSpeech } from './elevenlabs.ts';
import { SentenceChunker, isStopCommand, toSpeakable } from './speech-text.ts';

/** What the voice service needs from the agent; the Core wires it to the AgentRuntime. */
export interface ConversationPort {
  send(sessionId: string, text: string): Promise<{ runId: string; deltas: AsyncIterable<string>; done: Promise<{ status: string; approvalTitle?: string }> }>;
  stop(reason: string): Promise<void>;
}

export type VoiceEvent =
  | { type: 'transcript'; text: string; language?: string }
  | { type: 'text'; text: string }
  | { type: 'audio'; chunk: Uint8Array; sentence: number }
  | { type: 'notice'; message: string }
  | { type: 'stopped' }
  | { type: 'done'; runId?: string; status: string };

export class VoiceBudgetError extends FeroxesError {
  constructor(message: string) {
    super('voice_budget', message);
  }
}

interface MeterDeps {
  budget: BudgetGate;
  ledger: UsageLedger;
  prices: PriceBook;
  clock: Clock;
}

/** Voice spending goes through the same reservations and ledger as model tokens. */
async function metered<T>(deps: MeterDeps, call: { providerId: string; modelId: string; route: string; priority: PriorityClass; units: number }, fn: () => Promise<T>): Promise<T> {
  const price = deps.prices.priceAt(call.modelId, deps.clock.now());
  const estimate = Math.ceil(call.units * (price?.unitPrice ?? 0) * 1e9);
  const r = await deps.budget.reserve({ requestId: uuidv7(), estimate, priority: call.priority, providerId: call.providerId, route: call.route });
  if (!r.ok) throw new VoiceBudgetError(`Budget "${r.budgetName}" is used up.`);
  const started = deps.clock.now();
  try {
    const result = await fn();
    const e = await deps.ledger.record({ providerId: call.providerId, modelId: call.modelId, route: call.route, taskType: call.route, priority: call.priority, attempt: 1, outcome: 'ok', usage: { inputTokens: 0, outputTokens: 0, units: call.units }, latencyMs: deps.clock.now() - started });
    await deps.budget.settle(r.reservationId, e.cost);
    return result;
  } catch (error) {
    await deps.ledger.record({ providerId: call.providerId, modelId: call.modelId, route: call.route, taskType: call.route, priority: call.priority, attempt: 1, outcome: 'error', errorClass: 'voice', usage: { inputTokens: 0, outputTokens: 0 } });
    await deps.budget.release(r.reservationId);
    throw error;
  }
}

/**
 * Push-to-talk turn (architecture §12): speech → text → agent → sentences → speech.
 * Speech starts after the first sentence, not after the whole answer.
 */
export class VoiceService {
  private readonly stt: SpeechToText;
  private readonly tts: TextToSpeech | undefined;
  private readonly port: ConversationPort;
  private readonly meter: MeterDeps;

  constructor(deps: { stt: SpeechToText; tts?: TextToSpeech; port: ConversationPort; budget: BudgetGate; ledger: UsageLedger; prices: PriceBook; clock?: Clock }) {
    this.stt = deps.stt;
    this.tts = deps.tts;
    this.port = deps.port;
    this.meter = { budget: deps.budget, ledger: deps.ledger, prices: deps.prices, clock: deps.clock ?? systemClock };
  }

  async *pushToTalk(input: { sessionId: string; audio: Uint8Array; mime: string; durationMs: number; speak?: boolean; voiceId?: string; signal?: AbortSignal }): AsyncGenerator<VoiceEvent> {
    const seconds = Math.max(1, Math.ceil(input.durationMs / 1000));
    const transcript = await metered(this.meter, { providerId: this.stt.providerId, modelId: this.stt.modelId, route: 'voice.stt', priority: 'interactive', units: seconds }, () =>
      this.stt.transcribe(input.audio, { mime: input.mime, ...(input.signal ? { signal: input.signal } : {}) }),
    );
    if (!transcript.text) {
      yield { type: 'notice', message: "I didn't catch that." };
      yield { type: 'done', status: 'empty' };
      return;
    }
    yield { type: 'transcript', text: transcript.text, ...(transcript.language ? { language: transcript.language } : {}) };

    if (isStopCommand(transcript.text)) {
      await this.port.stop('voice command');
      yield { type: 'stopped' };
      yield* this.say('Stopped.', input, 0);
      yield { type: 'done', status: 'stopped' };
      return;
    }

    const { runId, deltas, done } = await this.port.send(input.sessionId, transcript.text);
    const chunker = new SentenceChunker();
    let spoken = 0;
    let previous = '';
    let speak = input.speak !== false && !!this.tts;
    // Speech failures (budget, network) degrade to text instead of failing the turn.
    const self = this;
    async function* trySay(text: string): AsyncGenerator<VoiceEvent> {
      if (!speak) return;
      try {
        yield* self.say(text, input, ++spoken, previous);
        previous = text;
      } catch (error) {
        speak = false;
        yield { type: 'notice', message: error instanceof VoiceBudgetError ? `${error.message} Answering in text only.` : 'Speech failed; answering in text only.' };
      }
    }
    for await (const delta of deltas) {
      yield { type: 'text', text: delta };
      for (const sentence of speak ? chunker.push(delta) : []) yield* trySay(sentence);
    }
    const result = await done;
    const rest = chunker.flush();
    if (rest) yield* trySay(rest);
    if (result.status === 'waiting_approval') yield* trySay(`I need your approval first${result.approvalTitle ? `: ${result.approvalTitle}` : ''}. It's in the app.`);
    yield { type: 'done', runId, status: result.status };
  }

  /** Proactive speech (briefings, alerts). */
  async *speak(text: string, opts: { voiceId?: string; signal?: AbortSignal; priority?: PriorityClass } = {}): AsyncGenerator<VoiceEvent> {
    yield* this.say(text, opts, 0, '', opts.priority ?? 'important');
  }

  private async *say(text: string, opts: { voiceId?: string; signal?: AbortSignal }, sentence: number, previous = '', priority: PriorityClass = 'interactive'): AsyncGenerator<VoiceEvent> {
    const tts = this.tts;
    if (!tts) return;
    const clean = toSpeakable(text);
    if (!clean) return;
    const chunks: Uint8Array[] = [];
    await metered(this.meter, { providerId: tts.providerId, modelId: tts.modelId, route: 'voice.tts', priority, units: clean.length }, async () => {
      for await (const chunk of tts.stream(clean, { ...(opts.voiceId ? { voiceId: opts.voiceId } : {}), ...(previous ? { previousText: toSpeakable(previous) } : {}), ...(opts.signal ? { signal: opts.signal } : {}) })) chunks.push(chunk);
    });
    for (const chunk of chunks) yield { type: 'audio', chunk, sentence };
  }
}

/** Small async queue: events pushed by callbacks, consumed with for-await. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiting?: () => void;
  private closed = false;

  push(item: T) {
    this.items.push(item);
    this.waiting?.();
  }

  close() {
    this.closed = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((r) => (this.waiting = r));
      this.waiting = undefined;
    }
  }
}
