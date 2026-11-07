import { AbortedError } from './errors.ts';

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError(String(signal.reason ?? 'aborted')));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError(String(signal?.reason ?? 'aborted')));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** An AbortSignal that fires when any input fires. */
export function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any(signals.filter((s): s is AbortSignal => s !== undefined));
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortedError(String(signal.reason ?? 'aborted'));
}

/** Exponential backoff with full jitter. */
export function backoffMs(attempt: number, baseMs = 500, maxMs = 30_000, random: () => number = Math.random): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

/** A promise you can resolve from outside; used for approval waits and test choreography. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
