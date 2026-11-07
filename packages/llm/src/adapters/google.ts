import type { TokenUsage } from '@feroxes/metering';
import { ProviderError, parseDuration } from '../errors.ts';
import type { AdapterEvent, AdapterRequest, FinishReason, LlmMessage, ModelEntry, ProviderAdapter, ToolCall } from '../types.ts';
import { type FetchLike, parseSse, postJson, safeJson } from './http.ts';

type Part = Record<string, unknown>;
interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

// Keys the Gemini function-declaration schema (an OpenAPI subset) accepts.
const SCHEMA_KEYS = new Set(['type', 'format', 'description', 'nullable', 'enum', 'maxItems', 'minItems', 'properties', 'required', 'minProperties', 'maxProperties', 'minLength', 'maxLength', 'pattern', 'example', 'anyOf', 'propertyOrdering', 'default', 'items', 'minimum', 'maximum', 'title']);

/** Strips JSON Schema features Gemini rejects ($schema, additionalProperties, const …). */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'const') out.enum = [v];
    else if (k === 'properties' && v && typeof v === 'object') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    else if (k === 'items' || k === 'anyOf') out[k] = toGeminiSchema(v);
    else if (k === 'type' && Array.isArray(v)) {
      // ["string","null"] → type string + nullable
      const types = v.filter((t) => t !== 'null');
      out.type = types[0];
      if (v.includes('null')) out.nullable = true;
    } else if (SCHEMA_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Gemini needs thought signatures returned with function calls on the next turn. The adapter
 * stores the model's raw parts as providerState and replays them for the same provider kind.
 */
export function toGemini(messages: LlmMessage[]): { systemInstruction?: { parts: Part[] }; contents: Content[] } {
  const system: Part[] = [];
  const contents: Content[] = [];
  const push = (role: Content['role'], parts: Part[]) => {
    const last = contents.at(-1);
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const m of messages) {
    if (m.role === 'system') system.push({ text: m.content });
    else if (m.role === 'user') {
      push('user', typeof m.content === 'string' ? [{ text: m.content }] : m.content.map((p) => (p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: p.mediaType, data: p.dataBase64 } })));
    } else if (m.role === 'assistant') {
      const raw = m.providerState?.providerKind === 'google' ? (m.providerState.data as { parts?: Part[] } | undefined)?.parts : undefined;
      push('model', raw ?? [...(m.content ? [{ text: m.content }] : []), ...(m.toolCalls ?? []).map((c) => ({ functionCall: { name: c.name, args: c.args ?? {} } }))]);
    } else {
      const parsed = safeJson(m.content);
      push('user', [{ functionResponse: { name: m.toolName, response: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { result: m.content } } }]);
    }
  }
  return { ...(system.length ? { systemInstruction: { parts: system } } : {}), contents };
}

const FINISH: Record<string, FinishReason> = { STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter', BLOCKLIST: 'content_filter', PROHIBITED_CONTENT: 'content_filter', SPII: 'content_filter' };

export class GoogleAdapter implements ProviderAdapter {
  readonly kind = 'google' as const;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;

  constructor(o: { apiKey: string; baseUrl?: string; fetch?: FetchLike }) {
    this.baseUrl = (o.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    this.headers = { 'x-goog-api-key': o.apiKey };
    this.fetchImpl = o.fetch ?? fetch;
  }

  buildBody(req: AdapterRequest): Record<string, unknown> {
    const { systemInstruction, contents } = toGemini(req.messages);
    return {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(req.tools?.length ? { tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) })) }] } : {}),
      generationConfig: {
        maxOutputTokens: req.maxOutputTokens,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.output ? { responseMimeType: 'application/json', responseSchema: toGeminiSchema(req.output.schema) } : {}),
      },
    };
  }

  private retryHint = (_status: number, text: string) => {
    // google.rpc.RetryInfo: "retryDelay": "15s"
    const m = /"retryDelay"\s*:\s*"([^"]+)"/.exec(text);
    const ms = m ? parseDuration(m[1]) : undefined;
    return ms !== undefined ? { retryAfterMs: ms } : {};
  };

  async *stream(model: ModelEntry, req: AdapterRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    const url = `${this.baseUrl}/models/${encodeURIComponent(model.modelKey)}:streamGenerateContent?alt=sse`;
    const res = await postJson(this.fetchImpl, url, this.headers, this.buildBody(req), signal, this.retryHint);

    let finish: FinishReason = 'unknown';
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const modelParts: Part[] = [];
    let calls = 0;
    let responseId: string | undefined;

    for await (const ev of parseSse(res.body!, signal)) {
      const chunk = safeJson(ev.data) as Record<string, any> | undefined;
      if (!chunk) continue;
      if (chunk.error) throw new ProviderError(chunk.error.code === 429 ? 'rate_limited' : 'server_error', chunk.error.message ?? 'stream error');
      responseId ??= chunk.responseId;
      const candidate = chunk.candidates?.[0];
      for (const part of (candidate?.content?.parts ?? []) as Part[]) {
        modelParts.push(part);
        if (typeof part.text === 'string') {
          if (part.thought) yield { type: 'reasoning-delta', text: part.text };
          else yield { type: 'text-delta', text: part.text };
        }
        const fc = part.functionCall as { name?: string; args?: unknown; id?: string } | undefined;
        if (fc?.name) {
          calls++;
          const call: ToolCall = { id: fc.id ?? `gemini_${calls}_${fc.name}`, name: fc.name, args: fc.args ?? {} };
          yield { type: 'tool-call', call };
        }
      }
      if (candidate?.finishReason) finish = FINISH[candidate.finishReason] ?? 'unknown';
      const u = chunk.usageMetadata;
      if (u) {
        usage = {
          inputTokens: u.promptTokenCount ?? 0,
          outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
          ...(u.cachedContentTokenCount ? { cachedInputTokens: u.cachedContentTokenCount } : {}),
          ...(u.thoughtsTokenCount ? { reasoningTokens: u.thoughtsTokenCount } : {}),
        };
      }
    }
    if (calls > 0 && finish === 'stop') finish = 'tool_calls';
    yield { type: 'finish', reason: finish, usage, providerState: { parts: modelParts }, ...(responseId ? { providerRequestId: responseId } : {}) };
  }

  async embed(model: ModelEntry, texts: string[], signal: AbortSignal): Promise<{ vectors: number[][]; inputTokens: number }> {
    const url = `${this.baseUrl}/models/${encodeURIComponent(model.modelKey)}:batchEmbedContents`;
    const body = { requests: texts.map((text) => ({ model: `models/${model.modelKey}`, content: { parts: [{ text }] }, ...(model.dimensions ? { outputDimensionality: model.dimensions } : {}) })) };
    const res = await postJson(this.fetchImpl, url, this.headers, body, signal, this.retryHint);
    const json = (await res.json()) as { embeddings: { values: number[] }[] };
    // The API reports no token usage for embeddings; estimate it for the ledger.
    return { vectors: json.embeddings.map((e) => e.values), inputTokens: texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0) };
  }
}
