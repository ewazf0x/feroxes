import { type CoreEvent, online, subscribe } from './api.ts';
import { type Signal, signal } from './core.ts';

export interface Status {
  name: string;
  selfVersion: number;
  boots: number;
  since: number;
  state: 'running' | 'stopped';
  power: 'normal' | 'economy' | 'background_paused';
  attention: 'ambient' | 'focus' | 'silent' | 'proactive';
  voice: boolean;
  providers: { id: string; name: string }[];
  approvals: number;
  devicesOnline: number;
  spendToday?: { spent: number; limit: number };
}

export interface Toast {
  id: number;
  title: string;
  body?: string;
  urgency: 'low' | 'normal' | 'high';
}

export const connection = online;
export const status = signal<Status | null>(null);
export const toasts = signal<Toast[]>([]);
export const route = signal<string>(location.hash.slice(1) || 'today');

let toastId = 0;
export function toast(t: Omit<Toast, 'id'>): void {
  const id = ++toastId;
  toasts.update((xs) => [...xs, { ...t, id }]);
  setTimeout(() => toasts.update((xs) => xs.filter((x) => x.id !== id)), t.urgency === 'high' ? 9000 : 5000);
}

/** One SSE stream for the whole app; screens subscribe to typed topics here. */
const target = new EventTarget();
export function on<T = any>(topic: string, handler: (data: T) => void): () => void {
  const fn = (e: Event) => handler((e as CustomEvent).detail as T);
  target.addEventListener(topic, fn);
  return () => target.removeEventListener(topic, fn);
}

export function patchStatus(p: Partial<Status>): void {
  const cur = status.peek();
  if (cur) status.set({ ...cur, ...p });
}

/** Starts the shared event stream. Called once at boot. */
export function connect(): () => void {
  return subscribe((e: CoreEvent) => {
    target.dispatchEvent(new CustomEvent(e.event, { detail: e.data }));
    target.dispatchEvent(new CustomEvent('*', { detail: e }));
    if (e.event === 'hello') status.set(e.data as Status);
    else if (e.event === 'system') patchStatus({ state: e.data.state });
    else if (e.event === 'power') patchStatus({ power: e.data.mode });
    else if (e.event === 'attention') patchStatus({ attention: e.data.mode });
    else if (e.event === 'run.approval') patchStatus({ approvals: (status.peek()?.approvals ?? 0) + 1 });
    else if (e.event === 'notification') toast({ title: e.data.title, body: e.data.body, urgency: e.data.urgency ?? 'normal' });
  });
}

export function navigate(to: string): void {
  if (route.peek() === to) return;
  route.set(to); // set directly: hash changes are blocked in some embedded/opaque origins
  try {
    history.pushState(null, '', `#${to}`);
  } catch {
    /* no history in this context; the route still changes */
  }
}
const fromHash = () => route.set(location.hash.slice(1) || 'today');
window.addEventListener('hashchange', fromHash);
window.addEventListener('popstate', fromHash);

export type { Signal };
