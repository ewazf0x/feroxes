import type { TokenUsage } from '@feroxes/metering';
import { sleep } from '@feroxes/shared';
import { ProviderError } from '../errors.ts';
import { messageChars } from '../estimator.ts';
import type { AdapterEvent, AdapterRequest, ErrorClass, FinishReason, ModelEntry, ProviderAdapter, RateLimitInfo, ToolCall } from '../types.ts';

export type MockStep =
  | { kind: 'text'; text: string; chunks?: number; delayMs?: number }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; name: string; args: unknown; id?: string }
  | { kind: 'error'; errorClass: ErrorClass; status?: number; retryAfterMs?: number; message?: string }
  | { kind: 'delay'; ms: number }
  | { kind: 'hang' };

export interface MockResponse {
  steps: MockStep[];
  usage?: Partial<TokenUsage>;
  finishReason?: FinishReason;
  rateLimit?: RateLimitInfo;
  providerState?: unknown;
}

export interface MockCall {
  modelId: string;
  request: AdapterRequest;
}

export type MockResponder = (ctx: { model: ModelEntry; request: AdapterRequest; call: number }) => MockResponse | Promise<MockResponse>;

/**
 * Scripted provider for tests, chaos testing and keyless demo mode (Phase 1 plan §10).
 * Responses are queued per model; when a queue is empty the fallback responder answers.
 */
export class MockAdapter implements ProviderAdapter {
  readonly kind = 'mock' as const;
  readonly calls: MockCall[] = [];
  private readonly queues = new Map<string, MockResponse[]>();
  private readonly fallback: MockResponder;
  private embedDims: number;

  constructor(options: { fallback?: MockResponder; embedDims?: number } = {}) {
    this.fallback = options.fallback ?? (() => ({ steps: [{ kind: 'text', text: 'OK.' }] }));
    this.embedDims = options.embedDims ?? 64;
  }

  /** Queue responses for a model (by catalog id). */
  queue(modelId: string, ...responses: MockResponse[]): this {
    const q = this.queues.get(modelId) ?? [];
    q.push(...responses);
    this.queues.set(modelId, q);
    return this;
  }

  pending(modelId: string): number {
    return this.queues.get(modelId)?.length ?? 0;
  }

  async *stream(model: ModelEntry, request: AdapterRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    this.calls.push({ modelId: model.id, request });
    const call = this.calls.length;
    const response = this.queues.get(model.id)?.shift() ?? (await this.fallback({ model, request, call }));

    if (response.rateLimit) yield { type: 'rate-limit', info: response.rateLimit };

    let outputChars = 0;
    const toolCalls: ToolCall[] = [];
    for (const step of response.steps) {
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
      switch (step.kind) {
        case 'text': {
          const n = Math.max(1, step.chunks ?? 1);
          const size = Math.ceil(step.text.length / n);
          for (let i = 0; i < step.text.length; i += size) {
            if (step.delayMs) await sleep(step.delayMs, signal);
            const text = step.text.slice(i, i + size);
            outputChars += text.length;
            yield { type: 'text-delta', text };
          }
          if (step.text.length === 0) yield { type: 'text-delta', text: '' };
          break;
        }
        case 'reasoning':
          outputChars += step.text.length;
          yield { type: 'reasoning-delta', text: step.text };
          break;
        case 'tool': {
          const toolCall: ToolCall = { id: step.id ?? `call_${call}_${toolCalls.length + 1}`, name: step.name, args: step.args };
          toolCalls.push(toolCall);
          outputChars += JSON.stringify(step.args ?? {}).length + step.name.length;
          yield { type: 'tool-call', call: toolCall };
          break;
        }
        case 'error':
          throw new ProviderError(step.errorClass, step.message ?? `mock ${step.errorClass}`, {
            ...(step.status !== undefined ? { status: step.status } : {}),
            ...(step.retryAfterMs !== undefined ? { retryAfterMs: step.retryAfterMs } : {}),
          });
        case 'delay':
          await sleep(step.ms, signal);
          break;
        case 'hang':
          await new Promise((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
      }
    }

    const { chars } = messageChars(request.messages, request.tools);
    const usage: TokenUsage = {
      inputTokens: Math.ceil(chars / 4),
      outputTokens: Math.max(1, Math.ceil(outputChars / 4)),
      ...response.usage,
    };
    yield {
      type: 'finish',
      reason: response.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      usage,
      ...(response.providerState !== undefined ? { providerState: response.providerState } : {}),
    };
  }

  /** Deterministic pseudo-embeddings: hashed bag of words, so similar texts land near each other. */
  async embed(model: ModelEntry, texts: string[]): Promise<{ vectors: number[][]; inputTokens: number }> {
    const dims = model.dimensions ?? this.embedDims;
    const vectors = texts.map((t) => hashEmbedding(t, dims));
    return { vectors, inputTokens: texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0) };
  }
}

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'of', 'to', 'and', 'or', 'in', 'on', 'my', 'me', 'i', 'that', 'this', 'it', 'for', 'with', 'what', 'who', 'do', 'does', 'owner', "owner's", 'about']);

export function hashEmbedding(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  const words = text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}']+/gu) ?? [];
  for (const raw of words) {
    const w = raw.replace(/'s$/, '');
    if (STOP.has(w) || w.length < 2) continue;
    // Whole word plus 3-grams, so "sister" and "sisters" overlap.
    const grams = [w, ...Array.from({ length: Math.max(0, w.length - 2) }, (_, i) => w.slice(i, i + 3))];
    for (const g of grams) {
      let h = 2166136261;
      for (let i = 0; i < g.length; i++) h = Math.imul(h ^ g.charCodeAt(i), 16777619);
      const idx = (h >>> 0) % dims;
      v[idx]! += g === w ? 2 : 1;
    }
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
