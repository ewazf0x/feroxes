import { signal } from './core.ts';

/**
 * Connection to the local Core. In the Tauri app the shell injects window.__FEROXES__ with the
 * Core's URL and app token; in a browser preview the token comes from the URL fragment
 * (#token=…), which is never sent to a server.
 */
declare global {
  interface Window {
    __FEROXES__?: { url: string; token: string };
  }
}

function connection(): { url: string; token: string } {
  if (window.__FEROXES__) return window.__FEROXES__;
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
  if (fromHash) {
    sessionStorage.setItem('feroxes-token', fromHash);
    history.replaceState(null, '', location.pathname + location.search);
  }
  return { url: location.origin, token: sessionStorage.getItem('feroxes-token') ?? '' };
}

const conn = connection();
export const online = signal<'connecting' | 'online' | 'offline'>('connecting');

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
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
