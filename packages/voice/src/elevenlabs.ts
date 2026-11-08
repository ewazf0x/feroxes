import { FeroxesError } from '@feroxes/shared';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TextToSpeech {
  readonly providerId: string;
  readonly modelId: string; // catalog id used for pricing, e.g. "elevenlabs/eleven_flash_v2_5"
  stream(text: string, opts?: { voiceId?: string; previousText?: string; signal?: AbortSignal }): AsyncIterable<Uint8Array>;
}

export interface Transcript {
  text: string;
  language?: string;
  durationSec?: number;
}

export interface SpeechToText {
  readonly providerId: string;
  readonly modelId: string;
  transcribe(audio: Uint8Array, opts: { mime: string; languageHint?: string; signal?: AbortSignal }): Promise<Transcript>;
}

export class VoiceProviderError extends FeroxesError {
  readonly status: number;
  constructor(status: number, message: string) {
    super(status === 401 || status === 403 ? 'voice_auth' : status === 429 ? 'voice_rate_limited' : 'voice_error', message, { status });
    this.name = 'VoiceProviderError';
    this.status = status;
  }
}

const BASE = 'https://api.elevenlabs.io';

/**
 * ElevenLabs text-to-speech over HTTP streaming. `eleven_flash_v2_5` for replies (lowest latency),
 * `eleven_v4_turbo` for expressive briefings. `previous_text` keeps intonation continuous when a
 * reply is spoken sentence by sentence.
 */
export class ElevenLabsTts implements TextToSpeech {
  readonly providerId = 'elevenlabs';
  readonly modelId: string;
  private readonly model: string;
  private readonly o: { apiKey: string; voiceId: string; outputFormat: string; baseUrl: string; fetch: FetchLike };

  constructor(o: { apiKey: string; voiceId: string; model?: string; outputFormat?: string; baseUrl?: string; fetch?: FetchLike }) {
    this.model = o.model ?? 'eleven_flash_v2_5';
    this.modelId = `elevenlabs/${this.model}`;
    this.o = { apiKey: o.apiKey, voiceId: o.voiceId, outputFormat: o.outputFormat ?? 'mp3_44100_128', baseUrl: (o.baseUrl ?? BASE).replace(/\/+$/, ''), fetch: o.fetch ?? fetch };
  }

  async *stream(text: string, opts: { voiceId?: string; previousText?: string; signal?: AbortSignal } = {}): AsyncIterable<Uint8Array> {
    const url = `${this.o.baseUrl}/v1/text-to-speech/${encodeURIComponent(opts.voiceId ?? this.o.voiceId)}/stream?output_format=${encodeURIComponent(this.o.outputFormat)}`;
    const res = await this.o.fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': this.o.apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: this.model, ...(opts.previousText ? { previous_text: opts.previousText.slice(-500) } : {}) }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok || !res.body) throw new VoiceProviderError(res.status, `ElevenLabs TTS failed (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`);
    const reader = res.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        if (value?.length) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/** ElevenLabs Scribe speech-to-text (batch): right for push-to-talk clips. */
export class ElevenLabsStt implements SpeechToText {
  readonly providerId = 'elevenlabs';
  readonly modelId: string;
  private readonly model: string;
  private readonly o: { apiKey: string; baseUrl: string; fetch: FetchLike };

  constructor(o: { apiKey: string; model?: string; baseUrl?: string; fetch?: FetchLike }) {
    this.model = o.model ?? 'scribe_v2';
    this.modelId = `elevenlabs/${this.model}`;
    this.o = { apiKey: o.apiKey, baseUrl: (o.baseUrl ?? BASE).replace(/\/+$/, ''), fetch: o.fetch ?? fetch };
  }

  async transcribe(audio: Uint8Array, opts: { mime: string; languageHint?: string; signal?: AbortSignal }): Promise<Transcript> {
    const form = new FormData();
    form.set('model_id', this.model);
    if (opts.languageHint) form.set('language_code', opts.languageHint);
    form.set('file', new Blob([audio as Uint8Array<ArrayBuffer>], { type: opts.mime }), `clip.${opts.mime.split('/')[1]?.split(';')[0] ?? 'webm'}`);
    const res = await this.o.fetch(`${this.o.baseUrl}/v1/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': this.o.apiKey }, body: form, ...(opts.signal ? { signal: opts.signal } : {}) });
    if (!res.ok) throw new VoiceProviderError(res.status, `ElevenLabs STT failed (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`);
    const json = (await res.json()) as { text?: string; language_code?: string; words?: { end?: number }[] };
    const lastEnd = json.words?.at(-1)?.end;
    return { text: (json.text ?? '').trim(), ...(json.language_code ? { language: json.language_code } : {}), ...(lastEnd !== undefined ? { durationSec: lastEnd } : {}) };
  }
}
