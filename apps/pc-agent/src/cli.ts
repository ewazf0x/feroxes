#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionName } from '@feroxes/protocol';
import { DeviceAgent } from './agent.ts';
import { createExecutor } from './actions.ts';
import { FileCredentialStore, configDir, isPaused, pauseFlagFile, startActivityMonitor } from './local.ts';
import { collectState } from './state.ts';

const VERSION = '0.1.0';
const HELP = `feroxes-agent <command>

  pair <code>   Pair this PC with Feroxes using a code from Devices → Pair a device, then stay connected
  run           Connect with the saved pairing and stay connected (what autostart runs)
  pause         Pause Feroxes on this PC: nothing runs here until you resume
  resume        Resume
  status        Show the pairing and what this PC can do
  selftest      Try every capability on this PC without the Core and print what works
  forget        Delete the saved pairing (pair again afterwards)

Options: --core ws://127.0.0.1:7311/devices   (default: the running Core, from runtime.json)
Env: FEROXES_AGENT_ROOTS=dir1${process.platform === 'win32' ? ';' : ':'}dir2   folders Feroxes may read and write (default: your home folder)`;

const dir = configDir();
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function defaultCoreUrl(): string {
  try {
    const rt = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8')) as { url: string };
    return `${rt.url.replace(/^http/, 'ws').replace(/\/$/, '')}/devices`;
  } catch {
    return 'ws://127.0.0.1:7311/devices';
  }
}

const roots = (process.env.FEROXES_AGENT_ROOTS ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
const executor = createExecutor({ roots });
const credentials = new FileCredentialStore(dir);
const log = (level: string, msg: string) => process.stderr.write(`[${new Date().toISOString()}] ${level} ${msg}\n`);

async function connect(pairCode?: string) {
  const monitor = startActivityMonitor();
  const agent = new DeviceAgent({
    coreUrl: flag('--core') ?? defaultCoreUrl(),
    info: { name: process.env.FEROXES_DEVICE_NAME || hostname(), platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux', appVersion: VERSION },
    executor,
    credentials,
    state: () => collectState({ extra: { ...(monitor.idleSeconds() !== undefined ? { idleSeconds: Math.round(monitor.idleSeconds()!) } : {}) } }),
    idleSeconds: () => monitor.idleSeconds(),
    pausedFlag: () => isPaused(dir),
    log,
  });
  monitor.onChange((e) => {
    if (e.kind === 'app') agent.event('foreground_changed', { app: e.app });
    else agent.event(e.kind === 'locked' ? 'screen_locked' : 'screen_unlocked', {});
  });
  const shutdown = async () => {
    monitor.stop();
    await agent.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // Started by the Core or the desktop app: their stdin pipe is our lifeline.
  if (process.env.FEROXES_PARENT_PIPE === '1') {
    process.stdin.on('end', () => void shutdown());
    process.stdin.on('error', () => void shutdown());
    process.stdin.resume();
  }
  try {
    await agent.start(pairCode ? { pairCode } : {});
    log('info', `This PC is connected as "${hostname()}" with: ${executor.capabilities().join(', ')}. Allowed folders: ${executor.roots.join(', ')}`);
  } catch (error) {
    log('error', (error as Error).message);
    monitor.stop();
    process.exit(2);
  }
}

async function selftest() {
  const rows: [string, string, string][] = [];
  const caps = executor.capabilities();
  const ctrl = new AbortController();
  const tmp = await mkdtemp(join(roots[0] ?? tmpdir(), '.feroxes-selftest-'));
  const tryIt = async (name: string, action: ActionName, params: unknown, check: (d: Record<string, unknown>) => string) => {
    try {
      const d = (await executor.run(action, params, ctrl.signal)) as Record<string, unknown>;
      rows.push(['PASS', name, check(d)]);
    } catch (e) {
      rows.push(['FAIL', name, (e as Error).message.slice(0, 160)]);
    }
  };
  await tryIt('system.status', 'system.status', {}, (d) => String(d.text).split('\n')[0]!);
  await tryIt('fs.write', 'fs.write', { path: join(tmp, 'a.txt'), content: 'feroxes selftest', overwrite: false }, (d) => String(d.text));
  await tryIt('fs.read', 'fs.read', { path: join(tmp, 'a.txt') }, (d) => (d.content === 'feroxes selftest' ? 'content matches' : `unexpected: ${String(d.content)}`));
  await tryIt('fs.list', 'fs.list', { path: tmp }, (d) => `${String(d.count)} entries`);
  await tryIt('shell.run', 'shell.run', { command: 'echo feroxes', timeoutMs: 20_000 }, (d) => String(d.text).replace(/\s+/g, ' ').slice(0, 60));
  if (caps.includes('screen.capture')) await tryIt('screen.capture', 'screen.capture', { maxWidth: 1280 }, (d) => `${String(d.width)}×${String(d.height)} PNG, ${Math.round(String(d.dataBase64).length / 1365)} KB`);
  if (caps.includes('windows.list')) await tryIt('windows.list', 'windows.list', {}, (d) => `${String(d.text).split('\n').length} windows`);
  if (caps.includes('ui.tree')) await tryIt('ui.tree', 'ui.tree', { maxNodes: 60 }, (d) => `${String(d.count)} elements in "${String(d.window ?? '')}"`);
  if (caps.includes('apps.list')) await tryIt('apps.list', 'apps.list', {}, (d) => `${String(d.text).split('\n').length} apps`);
  if (caps.includes('clipboard')) {
    const before = (await executor.run('clipboard.read', {}, ctrl.signal).catch(() => ({ text: '' }))) as { text?: string };
    await tryIt('clipboard write+read', 'clipboard.write', { text: 'feroxes-selftest' }, () => 'written');
    await tryIt('clipboard.read', 'clipboard.read', {}, (d) => (String(d.text).trim() === 'feroxes-selftest' ? 'round trip ok' : `got "${String(d.text).slice(0, 30)}"`));
    await executor.run('clipboard.write', { text: before.text ?? '' }, ctrl.signal).catch(() => undefined); // restore
  }
  if (args.includes('--with-input') && caps.includes('input.keyboard')) await tryIt('input.key (shift)', 'input.key', { keys: ['shift'] }, () => 'pressed shift');
  await rm(tmp, { recursive: true, force: true });
  for (const [s, n, d] of rows) process.stdout.write(`${s.padEnd(5)} ${n.padEnd(22)} ${d}\n`);
  process.stdout.write(`\nAdvertised capabilities: ${caps.join(', ')}\n${caps.includes('input.pointer') ? '' : 'Mouse/keyboard control is not available on this platform/session.\n'}`);
  process.exit(rows.some((r) => r[0] === 'FAIL') ? 1 : 0);
}

const [command, arg] = args;
switch (command) {
  case 'pair':
    if (!arg && !process.env.FEROXES_PAIR_CODE) {
      process.stderr.write('Usage: feroxes-agent pair <code>\n');
      process.exit(1);
    }
    await connect(arg ?? process.env.FEROXES_PAIR_CODE);
    break;
  case 'run':
    // FEROXES_PAIR_CODE lets the Core pair its own PC on first start (used only if not paired yet).
    await connect(process.env.FEROXES_PAIR_CODE);
    break;
  case 'pause':
    mkdirSync(dir, { recursive: true });
    writeFileSync(pauseFlagFile(dir), new Date().toISOString());
    process.stdout.write('Feroxes is paused on this PC. Run `feroxes-agent resume` to continue.\n');
    break;
  case 'resume':
    rmSync(pauseFlagFile(dir), { force: true });
    process.stdout.write('Feroxes may use this PC again.\n');
    break;
  case 'status': {
    const c = await credentials.load().catch(() => undefined);
    process.stdout.write(`${c ? `Paired as device ${c.deviceId} with ${c.coreUrl}` : 'Not paired.'}\nPaused: ${existsSync(pauseFlagFile(dir)) ? 'yes' : 'no'}\nCapabilities: ${executor.capabilities().join(', ')}\nAllowed folders: ${executor.roots.join(', ')}\n`);
    break;
  }
  case 'selftest':
    await selftest();
    break;
  case 'forget':
    await credentials.clear();
    process.stdout.write('Pairing deleted. Pair again with a new code.\n');
    break;
  default:
    process.stdout.write(`${HELP}\n`);
}
