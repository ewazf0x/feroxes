import { readFile, readdir, statfs } from 'node:fs/promises';
import { cpus, freemem, homedir, networkInterfaces, totalmem } from 'node:os';
import { join } from 'node:path';
import type { DeviceState } from '@feroxes/protocol';
import { type Runner, runProcess } from './run.ts';
import { runPs } from './windows.ts';

/** Builds the heartbeat state from the OS. Every field is optional; missing data is left out. */
export async function collectState(opts: { platform?: NodeJS.Platform; run?: Runner; extra?: Partial<DeviceState> } = {}): Promise<DeviceState> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runProcess;
  const state: DeviceState = { ...opts.extra };
  state.cpuPercent = await cpuPercent();
  state.memoryPercent = clamp(Math.round((1 - freemem() / totalmem()) * 100));
  try {
    const s = await statfs(platform === 'win32' ? (process.env.SystemDrive ?? 'C:') + '\\' : homedir());
    state.diskFreeGb = Math.round(((s.bavail * s.bsize) / 1024 ** 3) * 10) / 10;
  } catch {
    /* unknown */
  }
  state.network = network();
  const battery = await batteryState(platform, run).catch(() => undefined);
  if (battery) state.battery = battery;
  return state;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

async function cpuPercent(sampleMs = 250): Promise<number> {
  const snap = () => cpus().reduce((acc, c) => ({ idle: acc.idle + c.times.idle, total: acc.total + c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle }), { idle: 0, total: 0 });
  const a = snap();
  await new Promise((r) => setTimeout(r, sampleMs));
  const b = snap();
  const total = b.total - a.total;
  return total > 0 ? clamp(Math.round((1 - (b.idle - a.idle) / total) * 100)) : 0;
}

function network(): DeviceState['network'] {
  const up = Object.entries(networkInterfaces()).filter(([, addrs]) => addrs?.some((a) => !a.internal));
  if (up.length === 0) return 'offline';
  if (up.some(([n]) => /^(wl|wi-?fi|wlan|airport)/i.test(n))) return 'wifi';
  if (up.some(([n]) => /^(en|eth|ethernet)/i.test(n))) return 'ethernet';
  return 'unknown';
}

let winBattery: { at: number; value: DeviceState['battery'] | null } | undefined;

async function batteryState(platform: NodeJS.Platform, run: Runner): Promise<DeviceState['battery'] | undefined> {
  if (platform === 'linux') {
    const base = '/sys/class/power_supply';
    const bat = (await readdir(base).catch(() => [] as string[])).find((d) => d.startsWith('BAT'));
    if (!bat) return undefined;
    const percent = Number((await readFile(join(base, bat, 'capacity'), 'utf8')).trim());
    const st = (await readFile(join(base, bat, 'status'), 'utf8')).trim();
    return { percent: clamp(percent), charging: st === 'Charging' || st === 'Full' };
  }
  if (platform === 'win32') {
    // PowerShell is slow to start: refresh the battery once a minute, not every heartbeat.
    if (winBattery && Date.now() - winBattery.at < 60_000) return winBattery.value ?? undefined;
    const r = await runPs<{ battery?: DeviceState['battery'] | null }>(run, 'status', {}, { timeoutMs: 15_000 });
    winBattery = { at: Date.now(), value: r.battery ?? null };
    return r.battery ?? undefined;
  }
  if (platform === 'darwin') {
    const r = await run('pmset', ['-g', 'batt'], { timeoutMs: 5000 });
    const m = /(\d+)%;\s*(charging|discharging|charged|finishing charge|AC attached)/i.exec(r.stdout);
    return m ? { percent: clamp(Number(m[1])), charging: !/discharging/i.test(m[2]!) } : undefined;
  }
  return undefined;
}
