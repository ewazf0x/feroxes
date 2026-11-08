import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '../errors.ts';
import type { AdapterEvent, AdapterRequest, ModelEntry } from '../types.ts';
import { KiroAdapter, type SpawnLike, TOOL_SENTINEL, classifyKiroFailure, parseToolCall, renderPrompt } from './kiro.ts';

const model = (modelKey = 'default'): ModelEntry => ({ id: 'kiro/balanced', providerId: 'kiro', modelKey, displayName: 'Kiro', modality: 'chat', capabilities: ['tools', 'streaming', 'json_schema', 'reasoning'], contextWindow: 200_000, maxOutputTokens: 16_000, tier: 'balanced', enabled: true });

const req: AdapterRequest = {
  messages: [
    { role: 'system', content: 'You are Feroxes.' },
    { role: 'user', content: 'What time is it in Tokyo?' },
  ],
  tools: [{ name: 'time__now', description: 'Current time', parameters: { type: 'object', properties: { tz: { type: 'string' } } } }],
  maxOutputTokens: 1000,
};

/** Fake Kiro CLI: records the args, returns scripted stdout/exit. */
function fakeSpawn(out: string, opts: { exit?: number; stderr?: string } = {}): { spawn: SpawnLike; calls: { prompt: string; args: string[] }[] } {
  const calls: { prompt: string; args: string[] }[] = [];
  const spawn: SpawnLike = (prompt, args) => {
    calls.push({ prompt, args });
    return { stdout: out, stderrText: Promise.resolve(opts.stderr ?? ''), exitCode: Promise.resolve(opts.exit ?? 0), kill: () => {} };
  };
  return { spawn, calls };
}

async function drain(it: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const sig = () => new AbortController().signal;

test('renderPrompt carries the system text, the tool protocol and the conversation', () => {
  const p = renderPrompt(model(), req);
  assert.match(p, /You are Feroxes\./);
  assert.match(p, new RegExp(TOOL_SENTINEL));
  assert.match(p, /time__now: Current time/);
  assert.match(p, /Owner: What time is it in Tokyo\?/);
  assert.match(p, /You:$/);
});

test('a plain answer becomes one text delta then finish', async () => {
  const { spawn, calls } = fakeSpawn('It is early evening in Tokyo.');
  const events = await drain(new KiroAdapter({ spawn, apiKey: 'k' }).stream(model('default'), req, sig()));
  assert.deepEqual(events[0], { type: 'text-delta', text: 'It is early evening in Tokyo.' });
  assert.equal(events.at(-1)?.type, 'finish');
  assert.deepEqual(calls[0]!.args, ['chat', '--no-interactive'], 'no --model when modelKey is "default"');
});

test('a tool-call line is parsed into a tool-call event; --model passed when pinned', async () => {
  const { spawn, calls } = fakeSpawn(`Let me check.\n${TOOL_SENTINEL} {"name":"time__now","arguments":{"tz":"Asia/Tokyo"}}`);
  const events = await drain(new KiroAdapter({ spawn }).stream(model('claude-sonnet-5.5'), req, sig()));
  const call = events.find((e) => e.type === 'tool-call');
  assert.ok(call?.type === 'tool-call');
  assert.equal(call.call.name, 'time__now');
  assert.deepEqual(call.call.args, { tz: 'Asia/Tokyo' });
  assert.equal(events.at(-1)?.type, 'finish');
  assert.deepEqual(calls[0]!.args, ['chat', '--no-interactive', '--model', 'claude-sonnet-5.5']);
});

test('failures map to error classes so the router fails over to the API models', async () => {
  const quota = fakeSpawn('', { exit: 1, stderr: 'Error: insufficient credits remaining on your plan' });
  await assert.rejects(drain(new KiroAdapter({ spawn: quota.spawn }).stream(model(), req, sig())), (e: unknown) => e instanceof ProviderError && e.errorClass === 'quota_exhausted');
  const auth = fakeSpawn('', { exit: 1, stderr: 'not logged in; run kiro-cli login' });
  await assert.rejects(drain(new KiroAdapter({ spawn: auth.spawn }).stream(model(), req, sig())), (e: unknown) => e instanceof ProviderError && e.errorClass === 'auth_error');
  // An unknown non-zero exit is retryable (server_error) so Feroxes still falls over.
  assert.equal(classifyKiroFailure(1, 'weird crash').errorClass, 'server_error');
  assert.equal(classifyKiroFailure(4, 'agent not found').errorClass, 'invalid_request');
});

test('parseToolCall tolerates code fences and prose, rejects malformed calls', () => {
  assert.equal(parseToolCall(`${TOOL_SENTINEL} \`\`\`json\n{"name":"x","arguments":{"a":1}}\n\`\`\``)?.name, 'x');
  assert.deepEqual(parseToolCall(`${TOOL_SENTINEL} {"name":"x","args":{"nested":{"a":1}}}`)?.args, { nested: { a: 1 } });
  assert.equal(parseToolCall('just a normal answer'), undefined);
  assert.equal(parseToolCall(`${TOOL_SENTINEL} {not json}`), undefined);
});
