import type { TokenUsage } from '@feroxes/metering';
import { ProviderError } from '../errors.ts';
import type { AdapterEvent, AdapterRequest, FinishReason, LlmMessage, ModelEntry, ProviderAdapter, ToolCall } from '../types.ts';
import { type FetchLike, anthropicRateLimits, parseSse, postJson, safeJson } from './http.ts';

type Block =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string }; cache_control?: { type: 'ephemeral' } }
  | { type: 'tool_use'; id: string; name: string; input: unknown; cache_control?: { type: 'ephemeral' } }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; cache_control?: { type: 'ephemeral' } };

interface WireMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

const MAX_BREAKPOINTS = 4; // Anthropic allows at most four cache_control blocks per request

/**
 * Converts neutral messages to the Messages API shape: system text goes to `system`,
 * tool results become user-role `tool_result` blocks, and consecutive same-role turns merge.
 * `cacheBreakpoints` mark message indexes after which the prefix is cached.
 */
export function toAnthropic(messages: LlmMessage[], cacheBreakpoints: number[] = []): { system: Block[]; messages: WireMessage[] } {
  const system: Block[] = [];
  const out: WireMessage[] = [];
  const marks = new Set(cacheBreakpoints.slice(-MAX_BREAKPOINTS));

  messages.forEach((m, index) => {
    let blocks: Block[];
    let role: 'user' | 'assistant';
    if (m.role === 'system') {
      const block: Block = { type: 'text', text: m.content };
      if (marks.has(index)) block.cache_control = { type: 'ephemeral' };
      system.push(block);
      return;
    }
    if (m.role === 'user') {
      role = 'user';
      blocks = typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : m.content.map((p): Block => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.dataBase64 } }));
    } else if (m.role === 'assistant') {
      role = 'assistant';
      blocks = [
        ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
        ...(m.toolCalls ?? []).map((c): Block => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} })),
      ];
      if (blocks.length === 0) blocks = [{ type: 'text', text: '…' }];
    } else {
      role = 'user';
      blocks = [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) }];
    }
    if (marks.has(index)) blocks[blocks.length - 1]!.cache_control = { type: 'ephemeral' };
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  });
  return { system, messages: out };
}

const STOP: Record<string, FinishReason> = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter', pause_turn: 'stop' };

export class AnthropicAdapter implements ProviderAdapter {
  readonly kind = 'anthropic' as const;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;

  constructor(o: { apiKey: string; baseUrl?: string; version?: string; headers?: Record<string, string>; fetch?: FetchLike }) {
    this.baseUrl = (o.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    this.headers = { 'x-api-key': o.apiKey, 'anthropic-version': o.version ?? '2023-06-01', ...(o.headers ?? {}) };
    this.fetchImpl = o.fetch ?? fetch;
  }

  buildBody(model: ModelEntry, req: AdapterRequest): Record<string, unknown> {
    const { system, messages } = toAnthropic(req.messages, req.cacheBreakpoints);
    const tools = req.tools?.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    const systemBlocks = req.output
      ? [...system, { type: 'text' as const, text: `Respond with a single JSON object matching this JSON Schema, and nothing else:\n${JSON.stringify(req.output.schema)}` }]
      : system;
    return {
      model: model.modelKey,
      max_tokens: req.maxOutputTokens,
      stream: true,
      messages,
      ...(systemBlocks.length ? { system: systemBlocks } : {}),
      ...(tools?.length ? { tools } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
  }

  async *stream(model: ModelEntry, req: AdapterRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    const res = await postJson(this.fetchImpl, `${this.baseUrl}/v1/messages`, this.headers, this.buildBody(model, req), signal);
    const rate = anthropicRateLimits(res.headers);
    if (rate) yield { type: 'rate-limit', info: rate };

    const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();
    let finish: FinishReason = 'unknown';
    let requestId = res.headers.get('request-id') ?? undefined;
    const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

    for await (const ev of parseSse(res.body!, signal)) {
      const data = safeJson(ev.data) as Record<string, any> | undefined;
      if (!data) continue;
      switch (data.type) {
        case 'message_start': {
          const u = data.message?.usage ?? {};
          requestId ??= data.message?.id;
          usage.input = u.input_tokens ?? 0;
          usage.cacheRead = u.cache_read_input_tokens ?? 0;
          usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
          usage.output = u.output_tokens ?? 0;
          break;
        }
        case 'content_block_start': {
          const b = data.content_block ?? {};
          blocks.set(data.index, { type: b.type, ...(b.id ? { id: b.id } : {}), ...(b.name ? { name: b.name } : {}), json: '' });
          if (b.type === 'text' && b.text) yield { type: 'text-delta', text: b.text };
          break;
        }
        case 'content_block_delta': {
          const d = data.delta ?? {};
          if (d.type === 'text_delta') yield { type: 'text-delta', text: d.text };
          else if (d.type === 'thinking_delta') yield { type: 'reasoning-delta', text: d.thinking };
          else if (d.type === 'input_json_delta') {
            const b = blocks.get(data.index);
            if (b) b.json += d.partial_json ?? '';
          }
          break;
        }
        case 'content_block_stop': {
          const b = blocks.get(data.index);
          if (b?.type === 'tool_use') {
            const args = b.json ? safeJson(b.json) : {};
            if (args === undefined) throw new ProviderError('server_error', `model returned invalid JSON arguments for ${b.name}`);
            const call: ToolCall = { id: b.id ?? `toolu_${data.index}`, name: b.name ?? 'unknown', args };
            yield { type: 'tool-call', call };
          }
          break;
        }
        case 'message_delta':
          if (data.delta?.stop_reason) finish = STOP[data.delta.stop_reason] ?? 'unknown';
          if (data.usage?.output_tokens !== undefined) usage.output = data.usage.output_tokens;
          break;
        case 'error': {
          const type: string = data.error?.type ?? '';
          const message: string = data.error?.message ?? 'stream error';
          throw new ProviderError(type === 'overloaded_error' ? 'overloaded' : type === 'rate_limit_error' ? 'rate_limited' : type === 'api_error' ? 'server_error' : 'invalid_request', message);
        }
        default:
          break; // ping, message_stop
      }
    }

    // Anthropic's input_tokens excludes cached reads and cache writes; the ledger wants the total.
    const total: TokenUsage = {
      inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
      outputTokens: usage.output,
      ...(usage.cacheRead ? { cachedInputTokens: usage.cacheRead } : {}),
      ...(usage.cacheWrite ? { cacheWriteTokens: usage.cacheWrite } : {}),
    };
    yield { type: 'finish', reason: finish, usage: total, ...(requestId ? { providerRequestId: requestId } : {}) };
  }
}
