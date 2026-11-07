import { ProviderError, classifyHttp, classifyThrown, parseDuration, parseRetryAfter } from '../errors.ts';
import type { RateLimitInfo } from '../types.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Server-sent events parser (WHATWG format): handles CRLF, multi-line data,
 * comment lines (OpenRouter sends ": OPENROUTER PROCESSING"), and chunk boundaries.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer.startsWith('\r\n', newline) ? 2 : 1));
        if (line === '') {
          if (data.length > 0) yield { event: event || 'message', data: data.join('\n') };
          event = '';
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().startsWith('data:')) data.push(buffer.trim().slice(5).replace(/^ /, ''));
    if (data.length > 0) yield { event: event || 'message', data: data.join('\n') };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/** POSTs JSON; maps failures to ProviderError. `extraClassify` adds provider-specific hints. */
export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  extraClassify?: (status: number, text: string) => Partial<{ retryAfterMs: number }>,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  } catch (error) {
    throw classifyThrown(error, signal);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = classifyHttp(res.status, text, res.headers);
    const hint = extraClassify?.(res.status, text);
    if (hint?.retryAfterMs !== undefined && err.retryAfterMs === undefined) {
      throw new ProviderError(err.errorClass, err.message, { status: res.status, retryAfterMs: hint.retryAfterMs });
    }
    throw err;
  }
  if (!res.body) throw new ProviderError('server_error', 'empty response body', { status: res.status });
  return res;
}

const num = (v: string | null): number | undefined => {
  if (v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** OpenAI-style headers: x-ratelimit-{limit,remaining,reset}-{requests,tokens}. */
export function openAiRateLimits(headers: Headers, now = Date.now()): RateLimitInfo | undefined {
  const info: RateLimitInfo = {};
  const rl = num(headers.get('x-ratelimit-limit-requests'));
  const rr = num(headers.get('x-ratelimit-remaining-requests'));
  const tl = num(headers.get('x-ratelimit-limit-tokens'));
  const tr = num(headers.get('x-ratelimit-remaining-tokens'));
  if (rl !== undefined) info.requestsLimit = rl;
  if (rr !== undefined) info.requestsRemaining = rr;
  if (tl !== undefined) info.tokensLimit = tl;
  if (tr !== undefined) info.tokensRemaining = tr;
  const reset = Math.max(parseDuration(headers.get('x-ratelimit-reset-requests')) ?? 0, parseDuration(headers.get('x-ratelimit-reset-tokens')) ?? 0);
  if (reset > 0) info.resetAt = now + reset;
  return Object.keys(info).length > 0 ? info : undefined;
}

/** Anthropic headers: anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset}. */
export function anthropicRateLimits(headers: Headers): RateLimitInfo | undefined {
  const info: RateLimitInfo = {};
  const rl = num(headers.get('anthropic-ratelimit-requests-limit'));
  const rr = num(headers.get('anthropic-ratelimit-requests-remaining'));
  const tl = num(headers.get('anthropic-ratelimit-tokens-limit')) ?? num(headers.get('anthropic-ratelimit-input-tokens-limit'));
  const tr = num(headers.get('anthropic-ratelimit-tokens-remaining')) ?? num(headers.get('anthropic-ratelimit-input-tokens-remaining'));
  if (rl !== undefined) info.requestsLimit = rl;
  if (rr !== undefined) info.requestsRemaining = rr;
  if (tl !== undefined) info.tokensLimit = tl;
  if (tr !== undefined) info.tokensRemaining = tr;
  const resets = ['anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-tokens-reset', 'anthropic-ratelimit-input-tokens-reset']
    .map((h) => Date.parse(headers.get(h) ?? ''))
    .filter((t) => Number.isFinite(t));
  if (resets.length > 0) info.resetAt = Math.max(...resets);
  return Object.keys(info).length > 0 ? info : undefined;
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export { parseRetryAfter };
