import { signal } from './core.ts';

/**
 * Connection to the local Core. In the Tauri app the shell injects window.__FEROXES__ with the
 * Core's URL and app token; in a browser preview the token comes from the URL fragment
 * (#token=…), which is never sent to a server.
 */
declare global {
  interface Window {
    __FEROXES__?: { url?: string; token?: string; error?: string };
  }
}

/** Set by the desktop shell when the Core could not be started, so the UI shows a clear message. */
export const bootError: string | null = window.__FEROXES__?.error ?? null;

/** sessionStorage/localStorage throw in opaque origins (previews); never let that crash the app. */
function safeStore(kind: 'session' | 'local'): Pick<Storage, 'getItem' | 'setItem'> {
  try {
    const s = kind === 'session' ? sessionStorage : localStorage;
    s.getItem('__probe__');
    return s;
  } catch {
    const mem = new Map<string, string>();
    return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) };
  }
}
export const sessionStore = safeStore('session');
export const localStore = safeStore('local');

function connection(): { url: string; token: string } {
  const injected = window.__FEROXES__;
  if (injected?.url) return { url: injected.url, token: injected.token ?? '' };
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
  if (fromHash) {
    sessionStore.setItem('feroxes-token', fromHash);
    history.replaceState(null, '', location.pathname + location.search);
  }
  return { url: location.origin, token: sessionStore.getItem('feroxes-token') ?? '' };
}

const conn = connection();
export const online = signal<'connecting' | 'online' | 'offline'>('connecting');

/** Demo/preview mode: ?demo=1 serves canned data so the UI runs with no Core (screenshots, first run). */
export const DEMO = new URLSearchParams(location.search).has('demo');

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (DEMO) {
    const { demoResponse } = await import('./fixtures.ts');
    return demoResponse(path, init) as Promise<T>;
  }
  const res = await fetch(`${conn.url}/api${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${conn.token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export type CoreEvent = { event: string; data: any };

/**
 * Server-sent events over fetch (EventSource can't send the token header). Reconnects with
 * backoff and reports connection state for the UI.
 */
export function subscribe(onEvent: (e: CoreEvent) => void): () => void {
  if (DEMO) {
    online.set('online');
    void onEvent;
    return () => {};
  }
  let stopped = false;
  let controller: AbortController | undefined;
  let attempt = 0;
  const loop = async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch(`${conn.url}/api/events`, { headers: { authorization: `Bearer ${conn.token}` }, signal: controller.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        online.set('online');
        attempt = 0;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i: number;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event = 'message';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (data) onEvent({ event, data: JSON.parse(data) });
          }
        }
      } catch {
        if (stopped) return;
      }
      online.set('offline');
      await new Promise((r) => setTimeout(r, Math.min(10_000, 500 * 2 ** attempt++)));
    }
  };
  void loop();
  return () => {
    stopped = true;
    controller?.abort();
  };
}
