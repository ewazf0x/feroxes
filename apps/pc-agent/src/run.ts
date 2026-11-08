import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';

/**
 * Runs a program without a shell: arguments are passed as an array, never parsed by a shell, so
 * text from a command's parameters can't inject extra commands. Output is capped, and the process
 * (with its children on Windows) is killed on timeout or abort.
 */
export interface RunOptions {
  input?: string;
  env?: Record<string, string>;
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

export const runProcess: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const max = opts.maxBytes ?? 4 * 1024 * 1024;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    const out: Buffer[] = [];
    const errs: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    const take = (into: Buffer[]) => (chunk: Buffer) => {
      if (bytes >= max) return void (truncated = true);
      const room = max - bytes;
      into.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      bytes += Math.min(chunk.length, room);
      if (chunk.length > room) truncated = true;
    };
    child.stdout.on('data', take(out));
    child.stderr.on('data', take(errs));
    const kill = () => {
      if (child.exitCode !== null || child.killed) return;
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGKILL');
    };
    const timer = opts.timeoutMs ? setTimeout(() => ((timedOut = true), kill()), opts.timeoutMs) : undefined;
    const onAbort = () => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errs).toString('utf8'), truncated, timedOut });
    });
    child.stdin.on('error', () => {});
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });

/** Finds an executable on PATH (no shell involved). */
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const { delimiter, join } = process.platform === 'win32' ? { delimiter: ';', join: (a: string, b: string) => `${a}\\${b}` } : { delimiter: ':', join: (a: string, b: string) => `${a}/${b}` };
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, cmd + ext.toLowerCase());
      try {
        if (statIsFile(p)) return p;
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}

function statIsFile(p: string): boolean {
  if (!statSync(p).isFile()) return false;
  if (process.platform !== 'win32') accessSync(p, constants.X_OK);
  return true;
}

export class ActionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
