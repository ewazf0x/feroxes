import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadEnv } from './config.ts';
import { createFeroxes } from './container.ts';
import { startServer } from './server.ts';

const BOT = '123456789:AAHfakeTelegramBotTokenValueForTests12345';

test('integrations API: connect, list without secrets, activity, OAuth callback page, disconnect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fx-integrations-'));
  const fakeFetch = (async (input: string | URL) => {
    const u = String(input);
    if (u.endsWith('/getMe')) return Response.json({ ok: true, result: { id: 42, username: 'feroxes_bot' } });
    return Response.json({ ok: false, error_code: 404, description: 'Not Found' }, { status: 404 });
  }) as typeof fetch;
  const fx = await createFeroxes(loadEnv({ FEROXES_DATA_DIR: join(dir, 'data'), FEROXES_WORKSPACE_DIR: join(dir, 'ws') }), { dbPath: ':memory:', fetch: fakeFetch });
  const srv = await startServer(fx, { port: 0, token: 'app-token-for-tests' });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${srv.url}${path}`, { method, headers: { authorization: 'Bearer app-token-for-tests', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json().catch(() => null)) as any, text: '' };
  };
  try {
    const list = await call('GET', '/api/connectors');
    assert.equal(list.status, 200);
    assert.equal(list.json.length, 12);
    const tg = list.json.find((c: { id: string }) => c.id === 'telegram');
    assert.ok(tg.limitations.length && tg.setupSteps.length && tg.fields[0].secret === true);

    const connected = await call('POST', '/api/connectors/telegram/connect', { fields: { access_token: BOT }, capabilities: ['read'] });
    assert.equal(connected.status, 200);
    assert.equal(connected.json.connection.accountName, '@feroxes_bot');
    const after = await call('GET', '/api/connectors');
    assert.ok(!JSON.stringify(after.json).includes(BOT), 'no route returns a credential');
    assert.equal(after.json.find((c: { id: string }) => c.id === 'telegram').connections.length, 1);

    const activity = await call('GET', '/api/connectors/telegram/activity');
    assert.equal(activity.json[0].action, 'connector.telegram.connect');
    assert.ok(!JSON.stringify(activity.json).includes(BOT));

    // OAuth needs the owner's app first; a forged callback shows an error page and changes nothing.
    assert.match((await call('POST', '/api/connectors/google/connect', {})).json.error, /Add your Google OAuth app/);
    const cb = await fetch(`${srv.url}/oauth/callback?state=forged&code=x`);
    assert.equal(cb.status, 200);
    assert.match(await cb.text(), /Not connected[\s\S]*invalid or expired/);
    assert.equal(cb.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'");

    // Bad token: a clear error, nothing stored.
    const bad = await call('POST', '/api/connectors/telegram/connect', { fields: { access_token: '' } });
    assert.match(bad.json.error, /Bot token is required/);

    const id = connected.json.connection.id;
    assert.equal((await call('POST', `/api/connections/${id}/capabilities`, { capabilities: ['read', 'send'] })).json.enabledCapabilities.join(','), 'read,send');
    assert.equal((await call('DELETE', `/api/connections/${id}`)).status, 200);
    assert.equal((await call('GET', '/api/connectors')).json.find((c: { id: string }) => c.id === 'telegram').connections.length, 0);
    assert.equal(fx.secrets.has(`connector:${id}:access_token`), false, 'the vault entry is gone');
    assert.equal((await fetch(`${srv.url}/api/connectors`)).status, 401, 'the app token is still required');
  } finally {
    await srv.close();
    await fx.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
