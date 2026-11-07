import type { TokenUsage } from '@feroxes/metering';
import { ProviderError } from '../errors.ts';
import type { AdapterEvent, AdapterRequest, FinishReason, LlmMessage, ModelEntry, ProviderAdapter, ProviderKind, ToolCall } from '../types.ts';
import { type FetchLike, openAiRateLimits, parseSse, postJson, safeJson } from './http.ts';

export interface OpenAiCompatibleOptions {
  kind: Extract<ProviderKind, 'openai' | 'openai-compatible'>;
  apiKey?: string;
  baseUrl?: string; // default https://api.openai.com/v1
  headers?: Record<string, string>;
  fetch?: FetchLike;
}

type WireMessage =
  | { role: 'system' | 'user'; content: string | WirePart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

type WirePart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export function toOpenAiMessages(messages: LlmMessage[]): WireMessage[] {
  return messages.map((m): WireMessage => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content };
      case 'user':
        return {
          role: 'user',
          content: typeof m.content === 'string' ? m.content : m.content.map((p): WirePart => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.dataBase64}` } })),
        };
      case 'assistant':
        return {
          role: 'assistant',
          content: m.content || null,
          ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) } : {}),
        };
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
  });
}

const FINISH: Record<string, FinishReason> = { stop: 'stop', length: 'length', tool_calls: 'tool_calls', function_call: 'tool_calls', content_filter: 'content_filter' };

/**
 * OpenAI Chat Completions streaming. With `kind: 'openai-compatible'` the same wire format
 * serves OpenRouter, Groq, DeepSeek, Mistral, xAI, Together, LM Studio, vLLM and Ollama.
 */
export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly kind: Extract<ProviderKind, 'openai' | 'openai-compatible'>;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;

  constructor(o: OpenAiCompatibleOptions) {
    this.kind = o.kind;
    this.baseUrl = (o.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.headers = { ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}), ...(o.headers ?? {}) };
    this.fetchImpl = o.fetch ?? fetch;
  }

  buildBody(model: ModelEntry, req: AdapterRequest): Record<string, unknown> {
    const official = this.kind === 'openai';
    return {
      model: model.modelKey,
      messages: toOpenAiMessages(req.messages),
      stream: true,
      stream_options: { include_usage: true },
      // Newer OpenAI models take max_completion_tokens; most compatible servers take max_tokens.
      ...(official ? { max_completion_tokens: req.maxOutputTokens } : { max_tokens: req.maxOutputTokens }),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.tools?.length
        ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
        : {}),
      ...(req.output
        ? official || model.capabilities.includes('json_schema')
          ? { response_format: { type: 'json_schema', json_schema: { name: req.output.name, schema: req.output.schema, strict: false } } }
          : { response_format: { type: 'json_object' } }
        : {}),
      ...(official && req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}),
    };
  }

  async *stream(model: ModelEntry, req: AdapterRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    const res = await postJson(this.fetchImpl, `${this.baseUrl}/chat/completions`, this.headers, this.buildBody(model, req), signal);
    const rate = openAiRateLimits(res.headers);
    if (rate) yield { type: 'rate-limit', info: rate };

    const partial = new Map<number, { id: string; name: string; args: string }>();
    let finish: FinishReason = 'unknown';
    let usage: TokenUsage | undefined;
    let requestId: string | undefined = res.headers.get('x-request-id') ?? undefined;

    for await (const ev of parseSse(res.body!, signal)) {
      if (ev.data === '[DONE]') break;
      const chunk = safeJson(ev.data) as
        | {
            id?: string;
            error?: { message?: string; code?: string | number };
            choices?: { delta?: { content?: string | null; reasoning?: string; reasoning_content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number }; prompt_cache_hit_tokens?: number };
          }
        | undefined;
      if (!chunk) continue;
      if (chunk.error) {
        // OpenRouter reports upstream failures inside the stream.
        const code = Number(chunk.error.code);
        throw new ProviderError(code === 429 ? 'rate_limited' : code >= 500 || Number.isNaN(code) ? 'server_error' : 'invalid_request', chunk.error.message ?? 'stream error');
      }
      requestId ??= chunk.id;
      for (const choice of chunk.choices ?? []) {
        const d = choice.delta ?? {};
        const reasoning = d.reasoning ?? d.reasoning_content;
        if (reasoning) yield { type: 'reasoning-delta', text: reasoning };
        if (d.content) yield { type: 'text-delta', text: d.content };
        for (const tc of d.tool_calls ?? []) {
          const p = partial.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) p.id = tc.id;
          if (tc.function?.name) p.name += tc.function.name;
          if (tc.function?.arguments) p.args += tc.function.arguments;
          partial.set(tc.index, p);
        }
        if (choice.finish_reason) finish = FINISH[choice.finish_reason] ?? 'unknown';
      }
      if (chunk.usage) {
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.prompt_cache_hit_tokens ?? 0;
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          ...(cached ? { cachedInputTokens: cached } : {}),
          ...(chunk.usage.completion_tokens_details?.reasoning_tokens ? { reasoningTokens: chunk.usage.completion_tokens_details.reasoning_tokens } : {}),
        };
      }
    }

    for (const [, p] of [...partial.entries()].sort((a, b) => a[0] - b[0])) {
      const args = p.args ? safeJson(p.args) : {};
      if (args === undefined) throw new ProviderError('server_error', `model returned invalid JSON arguments for ${p.name}`);
      const call: ToolCall = { id: p.id || `call_${p.name}`, name: p.name, args };
      yield { type: 'tool-call', call };
    }
    if (partial.size > 0 && finish === 'stop') finish = 'tool_calls';
    yield { type: 'finish', reason: finish, usage: usage ?? { inputTokens: 0, outputTokens: 0 }, ...(requestId ? { providerRequestId: requestId } : {}) };
  }

  async embed(model: ModelEntry, texts: string[], signal: AbortSignal): Promise<{ vectors: number[][]; inputTokens: number }> {
    const res = await postJson(this.fetchImpl, `${this.baseUrl}/embeddings`, this.headers, { model: model.modelKey, input: texts, ...(model.dimensions ? { dimensions: model.dimensions } : {}) }, signal);
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[]; usage?: { prompt_tokens?: number } };
    const vectors = [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    return { vectors, inputTokens: json.usage?.prompt_tokens ?? 0 };
  }
}
