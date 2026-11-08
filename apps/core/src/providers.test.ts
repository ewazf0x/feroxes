import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { loadEnv } from './config.ts';
import { createFeroxes } from './container.ts';

/**
 * These tests run the real Providers service, router, adapters, ledger and budgets. External
 * services are replaced by LOCAL stand-ins (a loopback HTTP server that speaks Ollama's API, a stub
 * `kiro-cli` program), because this sandbox has no internet and no Kiro install. Passing here
 * proves the plumbing; a real provider is verified only by "Test connection" with a real account.
 */
async function localOllama(reply = 'OK') {
  const hits: string[] = [];
  const server = createServer(async (req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ models: [{ name: 'llama3.2:3b' }, { name: 'nomic-embed-text:latest' }] }));
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      const j = JSON.parse(body) as { stream?: boolean; model: string };
      if (j.model !== 'llama3.2:3b') {
        res.writeHead(404, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ error: { message: `model "${j.model}" not found, try pulling it first` } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: reply } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } })}\n\n`);
      return void res.end('data: [DONE]\n\n');
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, hits, close: () => (server.closeAllConnections(), server.close()) };
}

function setup(extra: Record<string, string> = {}, fetchImpl?: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), 'fx-providers-'));
  const env = loadEnv({ FEROXES_DATA_DIR: join(dir, 'data'), FEROXES_WORKSPACE_DIR: join(dir, 'ws'), ...extra });
  return { dir, env, start: () => createFeroxes(env, fetchImpl ? { fetch: fetchImpl } : {}), clean: () => rmSync(dir, { recursive: true, force: true }) };
}

async function chat(fx: Awaited<ReturnType<typeof createFeroxes>>, text: string) {
  const s = await fx.runtime.createSession('web');
  const run = await (await fx.runtime.sendMessage(s.id, text)).done;
  const last = (await fx.agentStore.messages(s.id)).filter((m) => m.role === 'assistant').at(-1);
  return { run, reply: last?.content ?? '', modelId: (last as { meta?: { modelId?: string } } | undefined)?.meta?.modelId ?? run.modelId };
}

test('Ollama end to end: find models over HTTP, pick one, real test request, chat answers, metered', async () => {
  const ollama = await localOllama();
  const t = setup();
  const fx = await t.start();
  try {
    const before = await chat(fx, 'hi');
    assert.match(before.reply, /no AI model is set up yet[\s\S]*Settings → Providers/, 'a clear message before anything is configured');

    fx.providers.update('ollama', { baseUrl: ollama.url, enabled: true });
    const found = await fx.providers.discover('ollama');
    assert.deepEqual(found.models.map((m) => [m.key, m.chat]), [['llama3.2:3b', true], ['nomic-embed-text:latest', false]]);
    fx.providers.update('ollama', { models: [{ key: 'llama3.2:3b', tier: 'local', enabled: true }] });
    fx.providers.setChatDefault('ollama', 'llama3.2:3b');

    const r = await fx.providers.test('ollama');
    assert.equal(r.ok, true, r.error ?? "");
    assert.equal(r.reply, 'OK');
    assert.deepEqual(r.tokens, { input: 12, output: 1 });
    assert.ok((r.latencyMs ?? -1) >= 0);

    const answered = await chat(fx, 'hi');
    assert.equal(answered.run.status, 'completed');
    assert.equal(answered.reply, 'OK');
    assert.equal(answered.modelId, 'ollama/llama3.2:3b');
    const usage = await fx.ledger.summarize({}, 'modelId');
    assert.ok(usage.some((u) => u.key === 'ollama/llama3.2:3b' && u.inputTokens > 0), 'chat usage is in the ledger');

    // A model id the provider doesn't have is explained, not swallowed.
    const wrong = await fx.providers.test('ollama', 'llama9:999b');
    assert.equal(wrong.ok, false);
    assert.match(wrong.error ?? '', /not in Ollama \(local\)'s model list/);
    const summary = await fx.providers.summaries();
    assert.equal(summary.chatModel?.modelKey, 'llama3.2:3b');
    assert.equal(summary.providers.find((p) => p.id === 'ollama')?.status, 'error', 'the last (failed) test is shown');
  } finally {
    await fx.shutdown();
    ollama.close();
    t.clean();
  }
});

test('API keys: sealed in the vault, shown masked, imported from .env once, kept across restarts', async () => {
  const KEY = 'sk-proj-REALLOOKINGBUTFAKEKEY0123456789abcdef';
  const t = setup({ OPENAI_API_KEY: KEY });
  let fx = await t.start();
  try {
    const s = await fx.providers.summaries();
    const openai = s.providers.find((p) => p.id === 'openai')!;
    assert.equal(openai.hasKey, true);
    assert.equal(openai.enabled, true);
    assert.match(openai.keyHint ?? '', /^sk-proj…cdef$/);
    assert.ok(!JSON.stringify(s).includes(KEY), 'no API response contains the key');
    fx.providers.setKey('anthropic', 'sk-ant-api03-ANOTHERFAKEKEY0123456789');
    await fx.shutdown();
    const db = new DatabaseSync(join(t.dir, 'data', 'feroxes.db'));
    const raw = (db.prepare('SELECT data FROM docs').all() as { data: string }[]).map((r) => r.data).join('\n');
    db.close();
    assert.ok(!raw.includes(KEY) && !raw.includes('ANOTHERFAKEKEY'), 'keys are not stored in plaintext');
    fx = await t.start();
    const after = await fx.providers.summaries();
    assert.equal(after.providers.find((p) => p.id === 'anthropic')?.hasKey, true, 'kept across a restart');
    fx.providers.removeKey('anthropic');
    assert.equal((await fx.providers.summaries()).providers.find((p) => p.id === 'anthropic')?.hasKey, false);
    assert.throws(() => fx.providers.update('anthropic', { enabled: true }), /Save an API key first/);
  } finally {
    await fx.shutdown();
    t.clean();
  }
});

test('fallback: a provider that rejects its key is skipped and chat is answered by the next one; errors explain why', async () => {
  const ollama = await localOllama('Hello from the fallback');
  const openaiCalls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host === 'api.openai.com') {
      openaiCalls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      return Response.json({ error: { message: 'Incorrect API key provided: sk-proj-****cdef.', type: 'invalid_request_error', code: 'invalid_api_key' } }, { status: 401 });
    }
    return globalThis.fetch(input, init);
  }) as typeof fetch;
  const t = setup({ OPENAI_API_KEY: 'sk-proj-REALLOOKINGBUTFAKEKEY0123456789abcdef' }, fetchImpl);
  const fx = await t.start();
  try {
    fx.providers.update('openai', { models: [{ key: 'gpt-test', tier: 'balanced', enabled: true }] });
    fx.providers.setChatDefault('openai', 'gpt-test');
    fx.providers.update('ollama', { baseUrl: ollama.url, enabled: true, models: [{ key: 'llama3.2:3b', tier: 'local', enabled: true }] });

    const r = await chat(fx, 'hi');
    assert.equal(r.reply, 'Hello from the fallback');
    assert.equal(r.modelId, 'ollama/llama3.2:3b');
    assert.ok(openaiCalls.some((c) => c.startsWith('POST /v1/chat/completions')), 'OpenAI was tried first');

    const tested = await fx.providers.test('openai');
    assert.equal(tested.ok, false);
    assert.equal(tested.auth, 'failed');
    assert.match(tested.error ?? '', /rejected the API key/);
  } finally {
    await fx.shutdown();
    ollama.close();
    t.clean();
  }
});

test('spending limit: a provider test is refused by the budget before any model request is sent', async () => {
  const sent: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    sent.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/v1/models') return Response.json({ data: [{ id: 'gpt-test' }] });
    return Response.json({ error: { message: 'should never be called' } }, { status: 500 });
  }) as typeof fetch;
  const t = setup({ OPENAI_API_KEY: 'sk-proj-REALLOOKINGBUTFAKEKEY0123456789abcdef', FEROXES_DAILY_BUDGET_USD: '0.000000001' }, fetchImpl);
  const fx = await t.start();
  try {
    fx.providers.update('openai', { models: [{ key: 'gpt-test', tier: 'balanced', enabled: true }] });
    const r = await fx.providers.test('openai');
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /spending limit/i);
    assert.deepEqual(sent, ['GET /v1/models'], 'only the free model list was requested');
  } finally {
    await fx.shutdown();
    t.clean();
  }
});

test('Kiro CLI: detected, run headless with the prompt on stdin, never with its own tools; signed-out is reported', async (t) => {
  if (process.platform === 'win32') return t.skip('the stub CLI is a POSIX shell script');
  const s = setup();
  const bin = join(s.dir, 'kiro-cli');
  const log = join(s.dir, 'kiro.log');
  writeFileSync(bin, `#!/bin/sh
echo "ARGS $*" >> "${log}"
case "$1" in
  --version) echo "kiro-cli 2.1.0"; exit 0 ;;
  whoami) if [ -n "$KIRO_STUB_SIGNED_OUT" ]; then echo "Not logged in" >&2; exit 1; fi; echo "Logged in with Builder ID"; echo "sam@example.com"; exit 0 ;;
  chat) prompt=$(cat); echo "STDIN_BYTES \${#prompt}" >> "${log}"; if [ -n "$KIRO_STUB_SIGNED_OUT" ]; then echo "error: You are not logged in, please log in with kiro-cli login" >&2; exit 1; fi; echo "OK"; exit 0 ;;
esac
exit 2
`);
  chmodSync(bin, 0o755);
  const fx = await s.start();
  try {
    fx.providers.update('kiro', { kiro: { command: bin } });
    assert.throws(() => fx.providers.update('kiro', { enabled: true }), /usage notice/, 'Kiro stays off until the owner accepts the terms notice');
    fx.providers.update('kiro', { acknowledgeKiroTerms: true, enabled: true, models: [{ key: 'default', tier: 'balanced', enabled: true }] });
    const st = await fx.providers.kiroStatus(true);
    assert.equal(st.installed, true);
    assert.equal(st.version, 'kiro-cli 2.1.0');
    assert.equal(st.authenticated, true);
    assert.match(st.detail ?? '', /sam@example\.com/);

    const r = await fx.providers.test('kiro');
    assert.equal(r.ok, true, r.error ?? "");
    assert.equal(r.reply, 'OK');
    const lines = readFileSync(log, 'utf8');
    assert.match(lines, /ARGS chat --no-interactive/);
    assert.ok(!/--trust/.test(lines), 'Kiro\'s own tools are never enabled');
    assert.match(lines, /STDIN_BYTES [1-9]\d*/, 'the prompt goes through stdin');

    process.env.KIRO_STUB_SIGNED_OUT = '1';
    assert.equal((await fx.providers.kiroStatus(true)).authenticated, false);
    const out = await fx.providers.test('kiro');
    assert.equal(out.ok, false);
    assert.match(out.error ?? '', /credentials|sign in|log/i);
  } finally {
    delete process.env.KIRO_STUB_SIGNED_OUT;
    await fx.shutdown();
    s.clean();
  }
});
