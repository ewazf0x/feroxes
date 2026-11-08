import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acceptWebSocket } from '@feroxes/devices';
import { PROTOCOL_VERSION } from '@feroxes/protocol';
import { loadEnv } from '../../core/src/config.ts';
import { createFeroxes } from '../../core/src/container.ts';
import { startServer } from '../../core/src/server.ts';
import { type CredentialStore, type Credentials, DeviceAgent } from './agent.ts';
import { createExecutor } from './actions.ts';
import { FileCredentialStore } from './local.ts';
import { collectState } from './state.ts';
import { psArgs, virtualKeys } from './windows.ts';

const memCreds = (): CredentialStore & { value?: Credentials } => {
  const s: CredentialStore & { value?: Credentials } = { load: async () => s.value, save: async (c) => void (s.value = c), clear: async () => void (s.value = undefined) };
  return s;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('timed out waiting');
    await wait(15);
  }
}

async function realCore() {
  const dir = mkdtempSync(join(tmpdir(), 'fx-agent-e2e-'));
  const env = loadEnv({ FEROXES_DATA_DIR: join(dir, 'data'), FEROXES_WORKSPACE_DIR: join(dir, 'ws') });
  const fx = await createFeroxes(env, { dbPath: ':memory:' });
  const srv = await startServer(fx, { port: 0, token: 't' });
  const root = join(dir, 'home');
  mkdirSync(root, { recursive: true });
  return { fx, srv, dir, root, wsUrl: `ws://127.0.0.1:${srv.port}/devices`, close: async () => (await srv.close(), await wait(30), await fx.shutdown(), rmSync(dir, { recursive: true, force: true })) };
}

test('the PC agent pairs with the real Core over WebSocket and executes signed commands for real', async () => {
  const core = await realCore();
  const creds = memCreds();
  const agent = new DeviceAgent({ coreUrl: core.wsUrl, info: { name: 'Test PC', platform: 'linux', appVersion: '0.1.0' }, executor: createExecutor({ roots: [core.root] }), credentials: creds, heartbeatMs: 100, state: () => collectState() });
  try {
    await agent.start({ pairCode: core.fx.hub.createPairingCode().code });
    assert.equal(agent.status, 'online');
    assert.ok(creds.value?.token && creds.value.coreKey === core.fx.hub.publicKey(), 'token saved and Core key pinned');
    const [pc] = core.fx.hub.online('desktop');
    assert.ok(pc?.capabilities.includes('fs') && pc.capabilities.includes('shell') && pc.capabilities.includes('system.status'));

    const file = join(core.root, 'notes', 'hello.txt');
    mkdirSync(join(core.root, 'notes'));
    const exec = (action: Parameters<typeof core.fx.hub.execute>[0]['action'], params: unknown, extra: Partial<Parameters<typeof core.fx.hub.execute>[0]> = {}) => core.fx.hub.execute({ kind: 'desktop', action, params, ...extra }) as Promise<Record<string, unknown>>;
    assert.match(String((await exec('fs.write', { path: file, content: 'hi from Feroxes' })).text), /Created/);
    assert.equal((await exec('fs.read', { path: file })).content, 'hi from Feroxes');
    assert.match(String((await exec('fs.list', { path: join(core.root, 'notes') })).text), /hello\.txt/);
    await assert.rejects(exec('fs.write', { path: file, content: 'x' }), /already exists/);
    assert.match(String((await exec('shell.run', { command: 'echo feroxes-$((6*7))', cwd: core.root })).text), /^exit 0\nferoxes-42/);
    assert.match(String((await exec('system.status', {})).text), /CPU \d+%, memory \d+%/);

    // Folder limits hold, including through a symlink that points outside the allowed root.
    await assert.rejects(exec('fs.read', { path: '/etc/hostname' }), /outside the folders/);
    symlinkSync('/etc', join(core.root, 'escape'));
    await assert.rejects(exec('fs.list', { path: join(core.root, 'escape') }), /outside the folders/);
    await assert.rejects(exec('fs.read', { path: 'relative.txt' }), /absolute path/);

    // Heartbeats reach the hub with real state.
    await until(() => (core.fx.hub.online('desktop')[0]?.state.memoryPercent ?? -1) >= 0);

    // Cancel: the hub's abort reaches the agent, which kills the running process.
    const ctrl = new AbortController();
    const started = Date.now();
    const long = exec('shell.run', { command: 'sleep 20', cwd: core.root }, { signal: ctrl.signal });
    await wait(150);
    ctrl.abort();
    await assert.rejects(long, /Cancelled/);
    await wait(100);
    assert.ok(Date.now() - started < 3000);

    // Local pause by the owner on the PC, then resume.
    agent.pause();
    await wait(50);
    await assert.rejects(exec('system.status', {}), /paused Feroxes/);
    agent.resume();
    await wait(50);
    await exec('system.status', {});

    // STOP in Feroxes halts the PC; resume brings it back.
    await core.fx.system.stop('owner', 'test');
    await wait(50);
    assert.equal(agent.halted, true);
    await assert.rejects(exec('system.status', {}), /stopped/);
    await core.fx.system.resume('owner', 'test');
    await wait(50);
    assert.equal(agent.halted, false);
    await exec('system.status', {});

    // Restart: the agent reconnects with its saved token (no new code).
    await agent.stop();
    await until(() => core.fx.hub.online().length === 0);
    const again = new DeviceAgent({ coreUrl: core.wsUrl, info: { name: 'Test PC', platform: 'linux', appVersion: '0.1.0' }, executor: createExecutor({ roots: [core.root] }), credentials: creds });
    await again.start();
    assert.equal(core.fx.hub.online('desktop').length, 1);
    await again.stop();
  } finally {
    await agent.stop();
    await core.close();
  }
});

test('the device endpoint refuses browsers (Origin header) and other paths', async () => {
  const core = await realCore();
  try {
    for (const [path, headers, expect] of [
      ['/devices', { Origin: 'https://evil.example' }, 403],
      ['/devices', { Origin: 'null' }, 403],
      ['/api/status', {}, 403],
    ] as const) {
      const status = await new Promise<number>((resolve) => {
        const req = (require_http()).request({ host: '127.0.0.1', port: core.srv.port, path, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
        req.on('upgrade', () => resolve(101));
        req.on('response', (res: { statusCode: number }) => resolve(res.statusCode));
        req.on('error', () => resolve(0));
        req.end();
      });
      assert.equal(status, expect, `${path} ${JSON.stringify(headers)}`);
    }
  } finally {
    await core.close();
  }
});

import * as http from 'node:http';
const require_http = () => http;

/** A fake "Core" with its own signing key, to check what the agent refuses. */
async function fakeCore() {
  const real = generateKeyPairSync('ed25519');
  const forged = generateKeyPairSync('ed25519');
  const coreKey = (real.publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const links: { send(f: string): void; close(): void }[] = [];
  const results: Record<string, unknown>[] = [];
  const server: Server = createServer();
  let nextKey = coreKey;
  server.on('upgrade', (req, socket, head) => {
    const link = acceptWebSocket(req, socket, head)!;
    links.push(link);
    link.onMessage((f) => {
      const m = JSON.parse(f);
      if (m.type === 'pair') {
        link.send(JSON.stringify({ type: 'paired', deviceId: 'dev-1', token: 'tok-1', coreKey }));
        link.send(JSON.stringify({ type: 'welcome', deviceId: 'dev-1', serverTime: Date.now(), coreKey, stopped: false }));
      } else if (m.type === 'hello') link.send(JSON.stringify({ type: 'welcome', deviceId: 'dev-1', serverTime: Date.now(), coreKey: nextKey, stopped: false }));
      else if (m.type === 'result') results.push(m);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const command = (opts: { id: string; deviceId?: string; expiresAt?: number; key?: 'real' | 'forged'; action?: string; params?: unknown }) => {
    const payload = JSON.stringify({ id: opts.id, deviceId: opts.deviceId ?? 'dev-1', action: opts.action ?? 'system.status', params: opts.params ?? {}, issuedAt: Date.now(), expiresAt: opts.expiresAt ?? Date.now() + 30_000 });
    const sig = sign(null, Buffer.from(payload), (opts.key === 'forged' ? forged : real).privateKey).toString('base64url');
    links.at(-1)!.send(JSON.stringify({ type: 'command', payload, sig }));
  };
  return { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/devices`, command, results, rotateKey: () => (nextKey = (forged.publicKey.export({ format: 'jwk' }) as { x: string }).x), close: () => (server.closeAllConnections(), server.close()) };
}

test('the agent executes only commands signed by its pinned Core, once, for itself, in time', async () => {
  const core = await fakeCore();
  const creds = memCreds();
  const executed: string[] = [];
  const executor = { capabilities: () => ['system.status' as const], run: async (a: string) => (executed.push(a), { text: 'ok' }) };
  const agent = new DeviceAgent({ coreUrl: core.url, info: { name: 'PC', platform: 'linux', appVersion: '0.1.0' }, executor: executor as never, credentials: creds });
  try {
    await agent.start({ pairCode: 'ABCD-EFGH' });
    core.command({ id: 'c1', key: 'forged' });
    core.command({ id: 'c2' });
    core.command({ id: 'c2' }); // replay
    core.command({ id: 'c3', deviceId: 'someone-else' });
    core.command({ id: 'c4', expiresAt: Date.now() - 60_000 });
    core.command({ id: 'c5', action: 'shell.run', params: { command: 'rm -rf /' } }); // not advertised
    core.command({ id: 'c6', action: 'definitely.not.an.action' });
    await until(() => core.results.length === 7);
    const byId = Object.fromEntries(core.results.map((r) => [r.id as string, r]));
    assert.equal((byId.c1 as { error: { code: string } }).error.code, 'bad_signature');
    assert.equal(core.results.filter((r) => r.id === 'c2' && r.ok).length, 1, 'executed exactly once');
    assert.ok(core.results.some((r) => r.id === 'c2' && !r.ok && /Replayed/.test((r as { error: { message: string } }).error.message)));
    assert.match((byId.c3 as { error: { message: string } }).error.message, /another device/);
    assert.match((byId.c4 as { error: { message: string } }).error.message, /expired/);
    assert.equal((byId.c5 as { error: { code: string } }).error.code, 'unsupported');
    assert.equal((byId.c6 as { error: { code: string } }).error.code, 'unsupported');
    assert.deepEqual(executed, ['system.status']);

    // A different Core key on reconnect means another (or impersonated) Core: refuse to connect.
    await agent.stop();
    core.rotateKey();
    const again = new DeviceAgent({ coreUrl: core.url, info: { name: 'PC', platform: 'linux', appVersion: '0.1.0' }, executor: executor as never, credentials: creds });
    await assert.rejects(again.start(), /signing key changed/);
    assert.equal(again.status, 'refused');
  } finally {
    await agent.stop();
    core.close();
  }
});

test('the agent runs as its own process (CLI), pairs from FEROXES_PAIR_CODE, and exits with its parent', async () => {
  const core = await realCore();
  const cfg = mkdtempSync(join(tmpdir(), 'fx-agent-cli-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(process.execPath, ['--no-warnings', join(import.meta.dirname, 'cli.ts'), 'run', '--core', core.wsUrl], {
      env: { ...process.env, XDG_CONFIG_HOME: cfg, HOME: cfg, FEROXES_PAIR_CODE: core.fx.hub.createPairingCode().code, FEROXES_PARENT_PIPE: '1', FEROXES_AGENT_ROOTS: core.root, FEROXES_DEVICE_NAME: 'CLI PC' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await until(() => core.fx.hub.online('desktop').length === 1, 10_000);
    assert.equal(core.fx.hub.online('desktop')[0]!.name, 'CLI PC');
    const r = (await core.fx.hub.execute({ kind: 'desktop', action: 'shell.run', params: { command: 'echo from-cli' } })) as { text: string };
    assert.match(r.text, /from-cli/);
    const saved = await new FileCredentialStore(join(cfg, 'feroxes')).load();
    assert.ok(saved?.token, 'credentials persisted to disk');
    const proc = child;
    const exited = new Promise<number | null>((res) => proc.on('exit', res));
    proc.stdin!.end(); // the parent goes away
    assert.equal(await Promise.race([exited, wait(5000).then(() => 'timeout')]), 0);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    rmSync(cfg, { recursive: true, force: true });
    await core.close();
  }
});

test('Windows backends: scripts are constants, parameters travel only as JSON in the environment', async () => {
  const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
  const fakeRun = async (cmd: string, args: string[], opts: { env?: Record<string, string> } = {}) => {
    calls.push({ cmd, args, ...(opts.env ? { env: opts.env } : {}) });
    return { code: 0, stdout: JSON.stringify({ mime: 'image/png', dataBase64: 'AAAA', width: 1280, height: 720, text: 'x' }), stderr: '', truncated: false, timedOut: false };
  };
  const ex = createExecutor({ platform: 'win32', run: fakeRun, roots: [tmpdir()], has: () => false });
  for (const c of ['screen.capture', 'ui.tree', 'ui.act', 'input.pointer', 'input.keyboard', 'apps.launch', 'windows.focus', 'clipboard', 'system.wake', 'fs', 'shell'] as const) assert.ok(ex.capabilities().includes(c), `win32 advertises ${c}`);
  const evil = "x'); Remove-Item C:\\ -Recurse; ('";
  await ex.run('apps.launch', { app: evil, args: [] }, new AbortController().signal);
  const call = calls.at(-1)!;
  assert.equal(call.cmd, 'powershell.exe');
  const script = Buffer.from(call.args.at(-1)!, 'base64').toString('utf16le');
  assert.ok(!script.includes(evil), 'parameters are never part of the script text');
  assert.equal(JSON.parse(call.env!.FEROXES_ARGS!).app, evil);
  assert.ok(script.includes('$env:FEROXES_ARGS | ConvertFrom-Json'));
  assert.deepEqual(psArgs('uiTree').slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
  assert.deepEqual(virtualKeys(['ctrl', 'shift', 's', 'F5', 'enter']), [0x11, 0x10, 0x53, 0x74, 0x0d]);
  assert.throws(() => virtualKeys(['hyper']), /Unknown key/);
  const shot = (await ex.run('screen.capture', { maxWidth: 1280 }, new AbortController().signal)) as { width: number };
  assert.equal(shot.width, 1280);
  // DPAPI-protected token file on Windows.
  const dir = mkdtempSync(join(tmpdir(), 'fx-dpapi-'));
  const store = new FileCredentialStore(dir, { platform: 'win32', run: async (_c, _a, o) => ({ code: 0, stdout: JSON.stringify(o?.env?.FEROXES_ARGS?.includes('"text"') ? { data: 'UFJPVEVDVEVE' } : { text: 'tok' }), stderr: '', truncated: false, timedOut: false }) });
  await store.save({ deviceId: 'd', token: 'tok', coreKey: 'k', coreUrl: 'ws://x' });
  const onDisk = (await import('node:fs')).readFileSync(join(dir, 'pc-agent.json'), 'utf8');
  assert.ok(!onDisk.includes('"tok"') && onDisk.includes('tokenDpapi'));
  writeFileSync(join(dir, 'x'), '');
  rmSync(dir, { recursive: true, force: true });
});
