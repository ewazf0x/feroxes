import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '../errors.ts';
import type { AdapterEvent, AdapterRequest, ModelEntry } from '../types.ts';
import { AnthropicAdapter, GoogleAdapter, OpenAiCompatibleAdapter, parseSse, toAnthropic, toGeminiSchema } from './index.ts';

// These fixtures follow each provider's documented streaming format. They verify parsing and
// request shaping offline; a live smoke test with real keys is still required before release.

function sseResponse(chunks: string[], init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: init.status ?? 200, headers: { 'content-type': 'text/event-stream', ...(init.headers ?? {}) } });
}

function fakeFetch(response: () => Response) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const f = async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    return response();
  };
  return { f, calls };
}

async function drain(it: AsyncIterable<AdapterEvent>) {
  const out: AdapterEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const model = (modelKey: string, extra: Partial<ModelEntry> = {}): ModelEntry => ({
  id: `x/${modelKey}`, providerId: 'x', modelKey, displayName: modelKey, modality: 'chat', capabilities: ['tools', 'streaming', 'json_schema'], contextWindow: 200_000, maxOutputTokens: 8192, tier: 'balanced', enabled: true, ...extra,
});

const baseReq: AdapterRequest = {
  messages: [
    { role: 'system', content: 'You are Feroxes.' },
    { role: 'user', content: 'What time is it in Paris?' },
  ],
  tools: [{ name: 'time_now', description: 'Current time', parameters: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { tz: { type: 'string' } }, required: ['tz'], additionalProperties: false } }],
  maxOutputTokens: 1000,
};

const sig = () => new AbortController().signal;

test('SSE parser: chunk boundaries, CRLF, comments, multi-line data', async () => {
  const res = sseResponse([': OPENROUTER PROCESSING\r\n\r\nevent: a\r\nda', 'ta: {"x":1}\r\n\r\ndata: line1\ndata: line2\n\n', 'data: [DONE]\n\n']);
  const events = [];
  for await (const e of parseSse(res.body!)) events.push(e);
  assert.deepEqual(events, [
    { event: 'a', data: '{"x":1}' },
    { event: 'message', data: 'line1\nline2' },
    { event: 'message', data: '[DONE]' },
  ]);
});

test('OpenAI: text, tool-call deltas across chunks, usage with cached tokens, rate-limit headers', async () => {
  const { f, calls } = fakeFetch(() =>
    sseResponse(
      [
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":"Let me "}}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"check."}}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"time_now","arguments":"{\\"tz\\":"}}]}}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Europe/Paris\\"}"}}]}}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":40,"prompt_tokens_details":{"cached_tokens":1024},"completion_tokens_details":{"reasoning_tokens":0}}}\n\n',
        'data: [DONE]\n\n',
      ],
      { headers: { 'x-ratelimit-limit-requests': '500', 'x-ratelimit-remaining-requests': '499', 'x-ratelimit-limit-tokens': '30000', 'x-ratelimit-remaining-tokens': '2000', 'x-ratelimit-reset-tokens': '6m0s' } },
    ),
  );
  const a = new OpenAiCompatibleAdapter({ kind: 'openai', apiKey: 'sk-test', fetch: f });
  const events = await drain(a.stream(model('gpt-x'), { ...baseReq, cacheKey: 'session-1' }, sig()));

  assert.equal(calls[0]!.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer sk-test');
  assert.equal(calls[0]!.body.max_completion_tokens, 1000);
  assert.equal(calls[0]!.body.prompt_cache_key, 'session-1');
  assert.deepEqual(calls[0]!.body.stream_options, { include_usage: true });
  assert.equal(calls[0]!.body.tools[0].function.name, 'time_now');

  const rate = events.find((e) => e.type === 'rate-limit');
  assert.ok(rate?.type === 'rate-limit' && rate.info.tokensRemaining === 2000 && rate.info.resetAt !== undefined);
  assert.equal(events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text).join(''), 'Let me check.');
  const call = events.find((e) => e.type === 'tool-call');
  assert.deepEqual(call?.type === 'tool-call' && call.call, { id: 'call_abc', name: 'time_now', args: { tz: 'Europe/Paris' } });
  const fin = events.at(-1);
  assert.ok(fin?.type === 'finish');
  assert.equal(fin.reason, 'tool_calls');
  assert.deepEqual(fin.usage, { inputTokens: 1200, outputTokens: 40, cachedInputTokens: 1024 });
});

test('OpenAI-compatible (OpenRouter): max_tokens, json_object fallback, in-stream upstream error', async () => {
  const { f, calls } = fakeFetch(() => sseResponse([': OPENROUTER PROCESSING\n\n', 'data: {"error":{"code":502,"message":"upstream provider error"}}\n\n']));
  const a = new OpenAiCompatibleAdapter({ kind: 'openai-compatible', apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1/', fetch: f });
  await assert.rejects(drain(a.stream(model('anthropic/claude', { capabilities: ['streaming'] }), { ...baseReq, output: { name: 'r', schema: { type: 'object' } } }, sig())), (e: unknown) => e instanceof ProviderError && e.errorClass === 'server_error');
  assert.equal(calls[0]!.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0]!.body.max_tokens, 1000);
  assert.deepEqual(calls[0]!.body.response_format, { type: 'json_object' });
  assert.equal(calls[0]!.body.prompt_cache_key, undefined);
});

test('OpenAI errors: 429 with retry-after, insufficient_quota, context length', async () => {
  const cases: [number, string, Record<string, string>, string][] = [
    [429, '{"error":{"message":"Rate limit reached","type":"requests"}}', { 'retry-after': '12' }, 'rate_limited'],
    [429, '{"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}', {}, 'quota_exhausted'],
    [400, '{"error":{"message":"This model\'s maximum context length is 128000 tokens","code":"context_length_exceeded"}}', {}, 'context_too_long'],
    [401, '{"error":{"message":"Incorrect API key"}}', {}, 'auth_error'],
    [500, 'oops', {}, 'server_error'],
  ];
  for (const [status, body, headers, expected] of cases) {
    const a = new OpenAiCompatibleAdapter({ kind: 'openai', apiKey: 'k', fetch: async () => new Response(body, { status, headers }) });
    await assert.rejects(drain(a.stream(model('m'), baseReq, sig())), (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.equal(e.errorClass, expected, `${status} ${body}`);
      if (headers['retry-after']) assert.equal(e.retryAfterMs, 12_000);
      return true;
    });
  }
});

test('Anthropic: request shape with cache breakpoints and merged tool results', () => {
  const { system, messages } = toAnthropic(
    [
      { role: 'system', content: 'static instructions' },
      { role: 'system', content: 'core memory' },
      { role: 'user', content: 'do two things' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'a', args: {} }, { id: 't2', name: 'b', args: { x: 1 } }] },
      { role: 'tool', toolCallId: 't1', toolName: 'a', content: 'A done' },
      { role: 'tool', toolCallId: 't2', toolName: 'b', content: 'failed', isError: true },
      { role: 'user', content: 'thanks' },
    ],
    [0, 1, 5],
  );
  assert.equal(system.length, 2);
  assert.deepEqual(system[0]?.cache_control, { type: 'ephemeral' });
  assert.deepEqual(system[1]?.cache_control, { type: 'ephemeral' });
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
  const toolResults = messages[2]!.content;
  assert.equal(toolResults.length, 3, 'two tool results and the next user text merge into one user turn');
  assert.deepEqual(toolResults[1], { type: 'tool_result', tool_use_id: 't2', content: 'failed', is_error: true, cache_control: { type: 'ephemeral' } });
});

test('Anthropic: streaming text, tool_use with split JSON, usage including cache reads/writes', async () => {
  const { f, calls } = fakeFetch(() =>
    sseResponse(
      [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":200,"cache_read_input_tokens":3000,"cache_creation_input_tokens":500,"output_tokens":1}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking"}}\n\n',
        'event: ping\ndata: {"type":"ping"}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_9","name":"time_now","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"tz\\": \\"Eur"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"ope/Paris\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":55}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ],
      { headers: { 'anthropic-ratelimit-requests-limit': '50', 'anthropic-ratelimit-requests-remaining': '49', 'anthropic-ratelimit-requests-reset': '2026-11-07T12:00:30Z' } },
    ),
  );
  const a = new AnthropicAdapter({ apiKey: 'sk-ant', fetch: f });
  const events = await drain(a.stream(model('claude-x'), { ...baseReq, cacheBreakpoints: [0] }, sig()));
  assert.equal(calls[0]!.url, 'https://api.anthropic.com/v1/messages');
  assert.equal((calls[0]!.init.headers as Record<string, string>)['x-api-key'], 'sk-ant');
  assert.equal((calls[0]!.init.headers as Record<string, string>)['anthropic-version'], '2023-06-01');
  assert.equal(calls[0]!.body.tools[0].input_schema.type, 'object');
  assert.deepEqual(calls[0]!.body.system[0].cache_control, { type: 'ephemeral' });

  const call = events.find((e) => e.type === 'tool-call');
  assert.deepEqual(call?.type === 'tool-call' && call.call, { id: 'toolu_9', name: 'time_now', args: { tz: 'Europe/Paris' } });
  const fin = events.at(-1);
  assert.ok(fin?.type === 'finish');
  assert.equal(fin.reason, 'tool_calls');
  assert.deepEqual(fin.usage, { inputTokens: 3700, outputTokens: 55, cachedInputTokens: 3000, cacheWriteTokens: 500 });
  assert.ok(events.some((e) => e.type === 'rate-limit' && e.info.requestsRemaining === 49));
});

test('Anthropic errors: overloaded 529, low credit balance, in-stream overloaded event', async () => {
  const a529 = new AnthropicAdapter({ apiKey: 'k', fetch: async () => new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', { status: 529 }) });
  await assert.rejects(drain(a529.stream(model('m'), baseReq, sig())), (e: unknown) => e instanceof ProviderError && e.errorClass === 'overloaded');
  const credit = new AnthropicAdapter({ apiKey: 'k', fetch: async () => new Response('{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}', { status: 400 }) });
  await assert.rejects(drain(credit.stream(model('m'), baseReq, sig())), (e: unknown) => e instanceof ProviderError && e.errorClass === 'quota_exhausted');
  const inStream = new AnthropicAdapter({ apiKey: 'k', fetch: async () => sseResponse(['event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n']) });
  await assert.rejects(drain(inStream.stream(model('m'), baseReq, sig())), (e: unknown) => e instanceof ProviderError && e.errorClass === 'overloaded');
});

test('Gemini: schema sanitizing, function calls with thought signatures kept as provider state', async () => {
  assert.deepEqual(toGeminiSchema(baseReq.tools![0]!.parameters), { type: 'object', properties: { tz: { type: 'string' } }, required: ['tz'] });
  assert.deepEqual(toGeminiSchema({ type: ['string', 'null'], const: 'x' }), { type: 'string', nullable: true, enum: ['x'] });

  const { f, calls } = fakeFetch(() =>
    sseResponse([
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Let me look."}]}}],"responseId":"r1"}\n\n',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"time_now","args":{"tz":"Europe/Paris"}},"thoughtSignature":"SIG123"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":900,"candidatesTokenCount":30,"thoughtsTokenCount":120,"cachedContentTokenCount":512}}\n\n',
    ]),
  );
  const g = new GoogleAdapter({ apiKey: 'AIza', fetch: f });
  const events = await drain(g.stream(model('gemini-flash'), baseReq, sig()));
  assert.equal(calls[0]!.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash:streamGenerateContent?alt=sse');
  assert.equal((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key'], 'AIza');
  assert.deepEqual(calls[0]!.body.systemInstruction, { parts: [{ text: 'You are Feroxes.' }] });
  assert.equal(calls[0]!.body.tools[0].functionDeclarations[0].parameters.additionalProperties, undefined);

  const fin = events.at(-1);
  assert.ok(fin?.type === 'finish');
  assert.equal(fin.reason, 'tool_calls');
  assert.deepEqual(fin.usage, { inputTokens: 900, outputTokens: 150, cachedInputTokens: 512, reasoningTokens: 120 });
  const state = fin.providerState as { parts: Record<string, unknown>[] };
  assert.equal(state.parts[1]?.thoughtSignature, 'SIG123');

  // Next turn: the stored parts (with the signature) are replayed verbatim.
  const { f: f2, calls: calls2 } = fakeFetch(() => sseResponse(['data: {"candidates":[{"content":{"parts":[{"text":"It is 13:00."}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1000,"candidatesTokenCount":8}}\n\n']));
  const g2 = new GoogleAdapter({ apiKey: 'AIza', fetch: f2 });
  await drain(g2.stream(model('gemini-flash'), {
    ...baseReq,
    messages: [
      ...baseReq.messages,
      { role: 'assistant', content: 'Let me look.', toolCalls: [{ id: 'g1', name: 'time_now', args: { tz: 'Europe/Paris' } }], providerState: { providerKind: 'google', data: state } },
      { role: 'tool', toolCallId: 'g1', toolName: 'time_now', content: '{"time":"13:00"}' },
    ],
  }, sig()));
  const contents = calls2[0]!.body.contents;
  assert.equal(contents[1].role, 'model');
  assert.equal(contents[1].parts[1].thoughtSignature, 'SIG123');
  assert.deepEqual(contents[2].parts[0], { functionResponse: { name: 'time_now', response: { time: '13:00' } } });
});

test('Gemini: 429 with RetryInfo retryDelay; daily quota exhausted', async () => {
  const body = '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"15s"}]}}';
  const g = new GoogleAdapter({ apiKey: 'k', fetch: async () => new Response(body, { status: 429 }) });
  await assert.rejects(drain(g.stream(model('m'), baseReq, sig())), (e: unknown) => e instanceof ProviderError && e.errorClass === 'rate_limited' && e.retryAfterMs === 15_000);
  const quota = new GoogleAdapter({ apiKey: 'k', fetch: async () => new Response('{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details."}}', { status: 429 }) });
  await assert.rejects(drain(quota.stream(model('m'), baseReq, sig())), (e: unknown) => e instanceof ProviderError && e.errorClass === 'quota_exhausted');
});

test('network failures and caller aborts are classified', async () => {
  const net = new OpenAiCompatibleAdapter({ kind: 'openai', apiKey: 'k', fetch: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); } });
  await assert.rejects(drain(net.stream(model('m'), baseReq, sig())), (e: unknown) => e instanceof ProviderError && e.errorClass === 'network' && /ECONNRESET/.test(e.message));
  const controller = new AbortController();
  controller.abort();
  const aborted = new OpenAiCompatibleAdapter({ kind: 'openai', apiKey: 'k', fetch: async (_u, init) => { init.signal?.throwIfAborted(); return sseResponse([]); } });
  await assert.rejects(drain(aborted.stream(model('m'), baseReq, controller.signal)), (e: unknown) => e instanceof ProviderError && e.errorClass === 'cancelled');
});
