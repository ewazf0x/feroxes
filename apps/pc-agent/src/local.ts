import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CredentialStore, Credentials } from './agent.ts';
import { type Runner, runProcess, which } from './run.ts';
import { psArgs, runPs } from './windows.ts';

/** Same folder the Core uses (apps/core/src/cli.ts feroxesConfigDir), so both find each other. */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'feroxes');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'feroxes');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'feroxes');
}

/**
 * Device credentials in <config>/pc-agent.json (0600). On Windows the token is additionally
 * encrypted with DPAPI (CurrentUser), so only this Windows account on this PC can use it.
 */
export class FileCredentialStore implements CredentialStore {
  readonly file: string;
  private readonly platform: NodeJS.Platform;
  private readonly run: Runner;
  constructor(dir: string, opts: { platform?: NodeJS.Platform; run?: Runner } = {}) {
    this.file = join(dir, 'pc-agent.json');
    this.platform = opts.platform ?? process.platform;
    this.run = opts.run ?? runProcess;
  }

  async load(): Promise<Credentials | undefined> {
    let raw: { deviceId: string; coreKey: string; coreUrl: string; token?: string; tokenDpapi?: string };
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      return undefined;
    }
    const token = raw.tokenDpapi ? (await runPs<{ text: string }>(this.run, 'unprotect', { data: raw.tokenDpapi })).text : raw.token;
    if (!token || !raw.deviceId || !raw.coreKey) return undefined;
    return { deviceId: raw.deviceId, token, coreKey: raw.coreKey, coreUrl: raw.coreUrl };
  }

  async save(c: Credentials): Promise<void> {
    mkdirSync(join(this.file, '..'), { recursive: true });
    const sealed = this.platform === 'win32' ? { tokenDpapi: (await runPs<{ data: string }>(this.run, 'protect', { text: c.token })).data } : { token: c.token };
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ deviceId: c.deviceId, coreKey: c.coreKey, coreUrl: c.coreUrl, ...sealed, pairedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
  }

  async clear(): Promise<void> {
    rmSync(this.file, { force: true });
  }
}

/** The owner's "pause Feroxes on this PC" switch: a flag file any local tool (or the tray) can set. */
export const pauseFlagFile = (dir: string) => join(dir, 'pc-agent.paused');
export const isPaused = (dir: string) => existsSync(pauseFlagFile(dir));

export interface ActivityMonitor {
  idleSeconds(): number | undefined;
  onChange(cb: (e: { kind: 'app'; app: string } | { kind: 'locked' } | { kind: 'unlocked' }) => void): void;
  stop(): void;
}

/**
 * Owner activity: seconds since the last mouse/keyboard input, the foreground app, and the lock
 * screen. Windows uses one long-running PowerShell helper (GetLastInputInfo); Linux uses
 * xprintidle when installed; macOS reads HIDIdleTime from ioreg.
 */
export function startActivityMonitor(opts: { platform?: NodeJS.Platform; run?: Runner } = {}): ActivityMonitor {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runProcess;
  let idle: number | undefined;
  let app = '';
  let locked: boolean | undefined;
  const listeners: Parameters<ActivityMonitor['onChange']>[0][] = [];
  const emit = (e: Parameters<Parameters<ActivityMonitor['onChange']>[0]>[0]) => listeners.forEach((l) => l(e));
  let child: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;

  if (platform === 'win32') {
    child = spawn('powershell.exe', psArgs('monitor'), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    child.stdout!.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line) as { idle: number; app: string; locked: boolean };
          idle = m.idle;
          if (m.app && m.app !== app) emit({ kind: 'app', app: (app = m.app) });
          if (locked !== undefined && m.locked !== locked) emit({ kind: m.locked ? 'locked' : 'unlocked' });
          locked = m.locked;
        } catch {
          /* partial line */
        }
      }
    });
    child.on('error', () => {});
  } else if (platform === 'darwin' || which('xprintidle')) {
    timer = setInterval(async () => {
      try {
        if (platform === 'darwin') {
          const r = await run('ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeoutMs: 3000 });
          const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(r.stdout);
          if (m) idle = Number(m[1]) / 1e9;
        } else {
          const r = await run('xprintidle', [], { timeoutMs: 3000 });
          if (r.code === 0) idle = Number(r.stdout.trim()) / 1000;
        }
      } catch {
        idle = undefined;
      }
    }, 1000);
    timer.unref();
  }

  return {
    idleSeconds: () => idle,
    onChange: (cb) => void listeners.push(cb),
    stop: () => {
      clearInterval(timer);
      child?.kill();
    },
  };
}
