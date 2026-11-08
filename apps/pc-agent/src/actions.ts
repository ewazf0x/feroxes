import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ActionName, ActionParams, Capability } from '@feroxes/protocol';
import type { Executor } from './agent.ts';
import { ActionError, type Runner, runProcess, which } from './run.ts';
import { runPs, virtualKeys } from './windows.ts';

/**
 * Real implementations of the device actions on this computer. What a platform can't do is not
 * advertised, so the Core never routes it here. File access is limited to the owner's allowed
 * folders (default: the home folder), checked after resolving symlinks.
 */
export interface ExecutorOptions {
  platform?: NodeJS.Platform;
  run?: Runner;
  roots?: string[];
  /** Overrides tool discovery (tests). */
  has?: (cmd: string) => boolean;
  kiroCommand?: string;
}

type Handler = (params: never, signal: AbortSignal) => Promise<unknown>;

const MAX_READ = 1_000_000;
const MAX_LIST = 500;

export function createExecutor(opts: ExecutorOptions = {}): Executor & { roots: string[] } {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runProcess;
  const has = opts.has ?? ((c: string) => !!which(c));
  const roots = (opts.roots?.length ? opts.roots : [homedir()]).map((r) => resolve(r));
  const kiro = opts.kiroCommand ?? 'kiro-cli';
  const win = platform === 'win32';
  const mac = platform === 'darwin';

  const tool = (...names: string[]) => names.find((n) => has(n));
  const linuxShot = !win && !mac ? tool('grim', 'import', 'scrot') : undefined;
  const linuxClipCopy = !win && !mac ? tool('wl-copy', 'xclip', 'xsel') : undefined;
  const linuxClipPaste = !win && !mac ? tool('wl-paste', 'xclip', 'xsel') : undefined;
  const xdotool = !win && !mac && has('xdotool');
  const wmctrl = !win && !mac && has('wmctrl');

  async function inRoots(p: string, forWrite = false): Promise<string> {
    if (!isAbsolute(p)) throw new ActionError('bad_params', `Use an absolute path (got "${p}").`);
    const target = resolve(p);
    let real: string;
    try {
      real = await realpath(target);
    } catch (e) {
      if (!forWrite || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw new ActionError('not_found', `${p} does not exist.`);
      real = join(await realpath(dirname(target)).catch(() => {
        throw new ActionError('not_found', `The folder ${dirname(p)} does not exist.`);
      }), basename(target));
    }
    const ok = await Promise.all(roots.map(async (r) => within(await realpath(r).catch(() => r), real)));
    if (!ok.some(Boolean)) throw new ActionError('forbidden', `${p} is outside the folders Feroxes may use on this PC (${roots.join(', ')}).`);
    return real;
  }

  const shell = async (command: string, cwd: string | undefined, timeoutMs: number, signal: AbortSignal) => {
    const dir = cwd ? await inRoots(cwd) : roots[0]!;
    const r = win
      ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(`[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${command}`, 'utf16le').toString('base64')], { cwd: dir, signal, timeoutMs, maxBytes: 200_000 })
      : await run('/bin/sh', ['-c', command], { cwd: dir, signal, timeoutMs, maxBytes: 200_000 });
    const text = [r.stdout.trimEnd(), r.stderr.trim() ? `[stderr]\n${r.stderr.trimEnd()}` : '', r.truncated ? '[output truncated]' : '', r.timedOut ? `[timed out after ${Math.round(timeoutMs / 1000)} s]` : ''].filter(Boolean).join('\n');
    return { text: `exit ${r.code ?? 'killed'}\n${text}`, exitCode: r.code };
  };

  const handlers: Partial<Record<ActionName, Handler>> = {
    'fs.list': (async (p: ActionParams<'fs.list'>) => {
      const dir = await inRoots(p.path);
      const entries = await readdir(dir, { withFileTypes: true });
      const rows = await Promise.all(
        entries.slice(0, MAX_LIST).map(async (e) => {
          const full = join(dir, e.name);
          const s = await stat(full).catch(() => undefined);
          return `${e.isDirectory() ? 'dir ' : 'file'} ${e.name}${s && !e.isDirectory() ? ` (${formatBytes(s.size)})` : ''}`;
        }),
      );
      return { text: `${dir}\n${rows.join('\n')}${entries.length > MAX_LIST ? `\n… ${entries.length - MAX_LIST} more` : ''}`, count: entries.length };
    }) as Handler,

    'fs.read': (async (p: ActionParams<'fs.read'>) => {
      const file = await inRoots(p.path);
      const s = await stat(file);
      if (s.isDirectory()) throw new ActionError('bad_params', `${p.path} is a folder; use fs.list.`);
      const buf = await readFile(file);
      const slice = buf.subarray(0, MAX_READ);
      if (slice.includes(0)) throw new ActionError('unsupported', `${p.path} looks like a binary file; only text files can be read.`);
      return { content: slice.toString('utf8') + (buf.length > MAX_READ ? `\n[… truncated, ${formatBytes(buf.length)} in total]` : ''), bytes: buf.length };
    }) as Handler,

    'fs.write': (async (p: ActionParams<'fs.write'>) => {
      const file = await inRoots(p.path, true);
      const exists = await stat(file).then(() => true, () => false);
      if (exists && !p.overwrite) throw new ActionError('exists', `${p.path} already exists. Ask again with overwrite to replace it.`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, p.content, { encoding: 'utf8', flag: p.overwrite ? 'w' : 'wx' });
      return { text: `${exists ? 'Overwrote' : 'Created'} ${file} (${formatBytes(Buffer.byteLength(p.content))}).`, path: file };
    }) as Handler,

    'shell.run': (async (p: ActionParams<'shell.run'>, signal: AbortSignal) => shell(p.command, p.cwd, p.timeoutMs, signal)) as Handler,

    'system.status': (async () => status(platform, run)) as Handler,

    ...(has(kiro)
      ? {
          'kiro.run': (async (p: ActionParams<'kiro.run'>, signal: AbortSignal) => {
            const cwd = await inRoots(p.repoPath);
            const args = ['chat', '--no-interactive', ...(p.trustTools.length ? [`--trust-tools=${p.trustTools.join(',')}`] : [])];
            const r = await run(kiro, args, { cwd, input: p.task, signal, timeoutMs: p.timeoutMs, maxBytes: 400_000 });
            return { exitCode: r.code ?? -1, output: `${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`.trim() };
          }) as Handler,
        }
      : {}),
  };

  if (win) {
    Object.assign(handlers, {
      'screen.capture': ((p: ActionParams<'screen.capture'>, s: AbortSignal) => runPs(run, 'screenshot', p, { signal: s })) as Handler,
      'input.click': ((p: ActionParams<'input.click'>, s: AbortSignal) => runPs(run, 'click', p, { signal: s })) as Handler,
      'input.scroll': ((p: ActionParams<'input.scroll'>, s: AbortSignal) => runPs(run, 'scroll', p, { signal: s })) as Handler,
      'input.type': ((p: ActionParams<'input.type'>, s: AbortSignal) => runPs(run, 'type', p, { signal: s })) as Handler,
      'input.key': ((p: ActionParams<'input.key'>, s: AbortSignal) => runPs(run, 'keys', { keys: p.keys, vks: virtualKeys(p.keys) }, { signal: s })) as Handler,
      'clipboard.read': ((_p: unknown, s: AbortSignal) => runPs(run, 'clipboardRead', {}, { signal: s })) as Handler,
      'clipboard.write': ((p: ActionParams<'clipboard.write'>, s: AbortSignal) => runPs(run, 'clipboardWrite', p, { signal: s })) as Handler,
      'apps.list': ((_p: unknown, s: AbortSignal) => runPs(run, 'appsList', {}, { signal: s })) as Handler,
      'apps.launch': ((p: ActionParams<'apps.launch'>, s: AbortSignal) => runPs(run, 'appsLaunch', p, { signal: s })) as Handler,
      'windows.list': ((_p: unknown, s: AbortSignal) => runPs(run, 'windowsList', {}, { signal: s })) as Handler,
      'windows.focus': ((p: ActionParams<'windows.focus'>, s: AbortSignal) => runPs(run, 'windowsFocus', p, { signal: s })) as Handler,
      'ui.tree': ((p: ActionParams<'ui.tree'>, s: AbortSignal) => runPs(run, 'uiTree', p, { signal: s, timeoutMs: 45_000 })) as Handler,
      'ui.act': ((p: ActionParams<'ui.act'>, s: AbortSignal) => runPs(run, 'uiAct', p, { signal: s })) as Handler,
      'system.schedule_wake': ((p: ActionParams<'system.schedule_wake'>, s: AbortSignal) => runPs(run, 'scheduleWake', p, { signal: s })) as Handler,
    });
  } else if (mac) {
    Object.assign(handlers, {
      'screen.capture': (async (p: ActionParams<'screen.capture'>, signal: AbortSignal) => {
        const file = join(tmpdir(), `feroxes-shot-${process.pid}-${Date.now()}.png`);
        await mustRun(run, 'screencapture', ['-x', '-t', 'png', ...(p.display !== undefined ? ['-D', String(p.display + 1)] : []), file], signal);
        await mustRun(run, 'sips', ['--resampleWidth', String(p.maxWidth), file], signal).catch(() => undefined);
        return pngResult(file);
      }) as Handler,
      'clipboard.read': (async (_p: unknown, signal: AbortSignal) => ({ text: (await mustRun(run, 'pbpaste', [], signal)).stdout })) as Handler,
      'clipboard.write': (async (p: ActionParams<'clipboard.write'>, signal: AbortSignal) => (await run('pbcopy', [], { input: p.text, signal }), { written: p.text.length })) as Handler,
      'apps.launch': (async (p: ActionParams<'apps.launch'>, signal: AbortSignal) => (await mustRun(run, 'open', ['-a', p.app, ...(p.args.length ? ['--args', ...p.args] : [])], signal), { launched: p.app })) as Handler,
      'apps.list': (async () => ({ text: (await readdir('/Applications')).filter((n) => n.endsWith('.app')).map((n) => n.slice(0, -4)).join('\n') })) as Handler,
    });
  } else {
    if (linuxShot)
      handlers['screen.capture'] = (async (p: ActionParams<'screen.capture'>, signal: AbortSignal) => {
        const file = join(tmpdir(), `feroxes-shot-${process.pid}-${Date.now()}.png`);
        if (linuxShot === 'grim') await mustRun(run, 'grim', [file], signal);
        else if (linuxShot === 'import') await mustRun(run, 'import', ['-window', 'root', '-resize', `${p.maxWidth}x>`, file], signal);
        else await mustRun(run, 'scrot', ['-o', file], signal);
        return pngResult(file);
      }) as Handler;
    if (linuxClipPaste)
      handlers['clipboard.read'] = (async (_p: unknown, signal: AbortSignal) => ({
        text: (await mustRun(run, linuxClipPaste, linuxClipPaste === 'xclip' ? ['-selection', 'clipboard', '-o'] : linuxClipPaste === 'xsel' ? ['--clipboard', '--output'] : ['--no-newline'], signal)).stdout,
      })) as Handler;
    if (linuxClipCopy)
      handlers['clipboard.write'] = (async (p: ActionParams<'clipboard.write'>, signal: AbortSignal) => {
        await run(linuxClipCopy, linuxClipCopy === 'xclip' ? ['-selection', 'clipboard'] : linuxClipCopy === 'xsel' ? ['--clipboard', '--input'] : [], { input: p.text, signal });
        return { written: p.text.length };
      }) as Handler;
    if (xdotool) {
      handlers['input.click'] = (async (p: ActionParams<'input.click'>, signal: AbortSignal) => {
        const button = { left: '1', middle: '2', right: '3' }[p.button];
        await mustRun(run, 'xdotool', ['mousemove', String(p.x), String(p.y), 'click', ...(p.double ? ['--repeat', '2'] : []), button], signal);
        return { clicked: true };
      }) as Handler;
      handlers['input.type'] = (async (p: ActionParams<'input.type'>, signal: AbortSignal) => (await mustRun(run, 'xdotool', ['type', '--delay', '12', '--', p.text], signal), { typed: p.text.length })) as Handler;
      handlers['input.key'] = (async (p: ActionParams<'input.key'>, signal: AbortSignal) => (await mustRun(run, 'xdotool', ['key', p.keys.map(xKey).join('+')], signal), { pressed: p.keys })) as Handler;
      handlers['input.scroll'] = (async (p: ActionParams<'input.scroll'>, signal: AbortSignal) => {
        const clicks = Math.max(1, Math.round(Math.abs(p.dy) / 100));
        await mustRun(run, 'xdotool', [...(p.x !== undefined && p.y !== undefined ? ['mousemove', String(p.x), String(p.y)] : []), 'click', '--repeat', String(clicks), p.dy > 0 ? '5' : '4'], signal);
        return { scrolled: true };
      }) as Handler;
    }
    if (wmctrl) {
      handlers['windows.list'] = (async (_p: unknown, signal: AbortSignal) => ({ text: (await mustRun(run, 'wmctrl', ['-l'], signal)).stdout.trim() })) as Handler;
      handlers['windows.focus'] = (async (p: ActionParams<'windows.focus'>, signal: AbortSignal) => (await mustRun(run, 'wmctrl', ['-i', '-a', p.windowId], signal), { focused: p.windowId })) as Handler;
    }
    if (has('gtk-launch') || has('xdg-open'))
      handlers['apps.launch'] = (async (p: ActionParams<'apps.launch'>, signal: AbortSignal) => {
        if (has('gtk-launch')) await mustRun(run, 'gtk-launch', [p.app, ...p.args], signal);
        else await mustRun(run, 'xdg-open', [p.app], signal);
        return { launched: p.app };
      }) as Handler;
    handlers['apps.list'] = (async () => {
      const dirs = ['/usr/share/applications', join(homedir(), '.local/share/applications')];
      const names = (await Promise.all(dirs.map((d) => readdir(d).catch(() => [] as string[])))).flat().filter((n) => n.endsWith('.desktop')).map((n) => n.slice(0, -8));
      return { text: [...new Set(names)].sort().join('\n'), count: names.length };
    }) as Handler;
  }

  const CAP: Record<ActionName, Capability> = {
    'screen.capture': 'screen.capture', 'ui.tree': 'ui.tree', 'ui.act': 'ui.act', 'input.click': 'input.pointer', 'input.type': 'input.keyboard', 'input.key': 'input.keyboard', 'input.scroll': 'input.pointer',
    'gesture.tap': 'gesture', 'gesture.swipe': 'gesture', 'global.action': 'global.action', 'apps.list': 'apps.list', 'apps.launch': 'apps.launch', 'windows.list': 'windows.list', 'windows.focus': 'windows.focus',
    'clipboard.read': 'clipboard', 'clipboard.write': 'clipboard', 'fs.list': 'fs', 'fs.read': 'fs', 'fs.write': 'fs', 'shell.run': 'shell', 'notifications.list': 'notifications.read', 'notifications.reply': 'notifications.reply',
    'audio.play': 'audio.play', 'system.status': 'system.status', 'system.schedule_wake': 'system.wake', 'kiro.run': 'kiro.cli',
  };
  const capabilities = (): Capability[] => {
    const caps = new Set<Capability>();
    for (const action of Object.keys(handlers) as ActionName[]) caps.add(CAP[action]);
    // A capability is only advertised when every action that needs it is implemented here.
    for (const [action, cap] of Object.entries(CAP) as [ActionName, Capability][]) if (caps.has(cap) && !handlers[action]) caps.delete(cap);
    return [...caps].sort();
  };

  return {
    roots,
    capabilities,
    async run(action, params, signal) {
      const h = handlers[action];
      if (!h) throw new ActionError('unsupported', `This PC can't do ${action}.`);
      return (h as (p: unknown, s: AbortSignal) => Promise<unknown>)(params, signal);
    },
  };
}

function within(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
}

async function mustRun(run: Runner, cmd: string, args: string[], signal: AbortSignal) {
  const r = await run(cmd, args, { signal, timeoutMs: 30_000 });
  if (r.code !== 0) throw new ActionError('failed', `${cmd} failed: ${r.stderr.trim().slice(0, 300) || `exit ${r.code}`}`);
  return r;
}

async function pngResult(file: string) {
  const buf = await readFile(file);
  await import('node:fs/promises').then((f) => f.rm(file, { force: true }));
  const width = buf.length > 24 ? buf.readUInt32BE(16) : 0;
  const height = buf.length > 24 ? buf.readUInt32BE(20) : 0;
  return { mime: 'image/png', dataBase64: buf.toString('base64'), width, height };
}

const xKey = (k: string) => ({ ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift', win: 'super', meta: 'super', cmd: 'super', enter: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'space', backspace: 'BackSpace', delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right', pageup: 'Prior', pagedown: 'Next', home: 'Home', end: 'End' })[k.toLowerCase()] ?? k;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** system.status: the same numbers the heartbeat carries, plus the busiest processes. */
async function status(platform: NodeJS.Platform, run: Runner) {
  const { collectState } = await import('./state.ts');
  const state = await collectState({ platform, run });
  let top: string[] = [];
  if (platform === 'win32') top = ((await runPs<{ top?: string[] }>(run, 'status', {}).catch(() => ({}))) as { top?: string[] }).top ?? [];
  else {
    const r = await run('ps', ['-eo', 'comm,%cpu,%mem', '--sort=-%cpu'], { timeoutMs: 5000 }).catch(() => undefined);
    if (r?.code === 0) top = r.stdout.trim().split('\n').slice(1, 9).map((l) => l.trim().replace(/\s+/g, ' '));
  }
  const lines = [
    `CPU ${state.cpuPercent ?? '?'}%, memory ${state.memoryPercent ?? '?'}%, ${state.diskFreeGb ?? '?'} GB free`,
    state.battery ? `Battery ${state.battery.percent}%${state.battery.charging ? ' (charging)' : ''}` : 'No battery',
    `Network: ${state.network ?? 'unknown'}`,
    top.length ? `Top processes:\n${top.join('\n')}` : '',
  ].filter(Boolean);
  return { text: lines.join('\n'), state, top };
}
