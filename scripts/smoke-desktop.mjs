#!/usr/bin/env node
// Smoke test for the packaged Core (src-tauri/resources/core), driven exactly the way the Rust
// shell drives it: spawn `node core/src/cli.js serve` with a stdin pipe, read the stdout handshake,
// make the shell's raw HTTP attach check, load the UI from the Core's origin, then close stdin and
// expect a clean exit. Also checks that a second Core refuses to start on a taken port.
// Portable (Linux, macOS, Windows); uses a throwaway config/data dir. Run after desktop:stage:
//   node scripts/smoke-desktop.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const entry = join(root, 'apps/desktop/src-tauri/resources/core/src/cli.js');
if (!existsSync(entry)) {
  console.error(`No packaged Core at ${entry}. Run: node scripts/build-desktop.mjs`);
  process.exit(2);
}

// Point the per-user config dir (where the handshake goes) at a temp dir on every OS, the same way
// feroxesConfigDir() in apps/core/src/cli.ts and dirs::config_dir() in the shell compute it.
const base = mkdtempSync(join(tmpdir(), 'feroxes-smoke-'));
const env = { ...process.env, FEROXES_PARENT_PIPE: '1', FEROXES_DESKTOP: '1', NODE_NO_WARNINGS: '1' };
delete env.FEROXES_DATA_DIR;
delete env.FEROXES_PORT;
let configDir;
if (process.platform === 'win32') {
  env.APPDATA = join(base, 'AppData', 'Roaming');
  configDir = join(env.APPDATA, 'feroxes');
} else if (process.platform === 'darwin') {
  env.HOME = base;
  configDir = join(base, 'Library', 'Application Support', 'feroxes');
} else {
  env.XDG_CONFIG_HOME = join(base, 'config');
  configDir = join(env.XDG_CONFIG_HOME, 'feroxes');
}
mkdirSync(base, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);

// The same request bytes as local_get() in apps/desktop/src-tauri/src/lib.rs.
function rawGet(port, path, token) {
  return new Promise((done) => {
    const sock = net.connect(port, '127.0.0.1');
    let data = '';
    sock.setTimeout(4000, () => {
      sock.destroy();
      done(null);
    });
    sock.on('connect', () => sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${token ? `Authorization: Bearer ${token}\r\n` : ''}Connection: close\r\n\r\n`));
    sock.on('data', (d) => (data += d));
    sock.on('end', () => done(data));
    sock.on('error', () => done(null));
  });
}
const statusOf = (resp) => (resp ? Number(resp.split('\r\n')[0].split(' ')[1]) : null);

const child = spawn(process.execPath, [entry, 'serve'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (d) => (stderr += d));
const handshake = await new Promise((done) => {
  let out = '';
  const timer = setTimeout(() => done(null), 30_000);
  child.stdout.on('data', (d) => {
    out += d;
    const line = out.split(/\r?\n/).find((l) => l.startsWith('FEROXES_READY '));
    if (line) {
      clearTimeout(timer);
      done(JSON.parse(line.slice('FEROXES_READY '.length)));
    }
  });
});
check('handshake on stdout', !!handshake, handshake ? handshake.url : stderr.slice(-400));

if (handshake) {
  const port = Number(new URL(handshake.url).port);
  const runtimeFile = join(configDir, 'runtime.json');
  check('runtime.json written to the config dir', existsSync(runtimeFile), runtimeFile);
  check('attach check: GET /api/status with token is 200', statusOf(await rawGet(port, '/api/status', handshake.token)) === 200);
  check('GET /api/status without token is 401', statusOf(await rawGet(port, '/api/status')) === 401);
  const page = await rawGet(port, '/');
  check('the Core serves the UI at /', statusOf(page) === 200 && /content-type: text\/html/i.test(page ?? ''));
  check('GET /dist/main.js is 200', statusOf(await rawGet(port, '/dist/main.js')) === 200);
  check('GET /tokens.css is 200', statusOf(await rawGet(port, '/tokens.css')) === 200);
  const res = await fetch(`${handshake.url}/api/status`, { headers: { authorization: `Bearer ${handshake.token}`, origin: handshake.url } });
  check('same-origin API call from the page is 200', res.status === 200);

  // Closing stdin is what happens when the app quits: the Core must exit cleanly and drop its handshake.
  const started = Date.now();
  const exited = new Promise((done) => child.on('exit', (code) => done(code)));
  child.stdin.end();
  const code = await Promise.race([exited, new Promise((done) => setTimeout(() => done('timeout'), 8000))]);
  check('stdin closed: the Core exits cleanly', code === 0, `exit ${code} after ${Date.now() - started} ms`);
  check('runtime.json removed on exit', !existsSync(runtimeFile));
  if (code === 'timeout') child.kill();
}

// A taken port: clear message and exit 1, never a second Core on the same data.
const blocker = net.createServer();
await new Promise((done) => blocker.listen(0, '127.0.0.1', done));
const takenPort = blocker.address().port;
const second = spawn(process.execPath, [entry, 'serve'], { env: { ...env, FEROXES_PORT: String(takenPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
let secondErr = '';
second.stderr.on('data', (d) => (secondErr += d));
const secondCode = await new Promise((done) => second.on('exit', done));
blocker.close();
check('port in use: exit 1 with a clear message', secondCode === 1 && /already in use/.test(secondErr), secondErr.trim().split(/\r?\n/).at(-1));

console.log(results.join('\n'));
rmSync(base, { recursive: true, force: true, maxRetries: 3 });
process.exit(results.some((l) => l.startsWith('FAIL')) ? 1 : 0);
