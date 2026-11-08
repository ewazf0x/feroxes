import { api, localStore } from './api.ts';
import { providersSection } from './providers.ts';
import { type Signal, append, h, signal, timeAgo, usd } from './core.ts';
import { icon } from './icons.ts';
import { navigate, on, toast } from './store.ts';

/** Loads data once, shows a skeleton meanwhile, re-renders on refresh events. */
function view<T>(load: () => Promise<T>, render: (d: T, reload: () => void) => Node, refreshOn: string[] = []): Node {
  const data = signal<T | null>(null);
  const error = signal<string>('');
  const reload = () => {
    load().then((d) => data.set(d)).catch((e) => error.set((e as Error).message));
  };
  reload();
  for (const topic of refreshOn) on(topic, () => reload());
  const host = h('div', { class: 'grow' });
  append(host, [() => (error() ? h('div', { class: 'empty' }, `Couldn't load: ${error()}`) : data() === null ? skeleton() : render(data() as T, reload))]);
  return host;
}

const skeleton = () => h('div', { class: 'card-grid' }, ...Array.from({ length: 4 }, () => h('div', { class: 'card' }, h('div', { class: 'skeleton', style: 'height: 14px; width: 40%' }), h('div', { class: 'skeleton', style: 'height: 28px; width: 70%; margin-top: 12px' }))));
const pageHead = (title: string, desc?: string) => h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, title), desc ? h('p', { class: 'page-desc' }, desc) : false);
const card = (...children: (Node | false | null | undefined)[]) => h('div', { class: 'card' }, ...(children as never[]));
const stat = (label: string, value: string | Node) => h('div', { class: 'stat card' }, h('div', { class: 'stat-label' }, label), typeof value === 'string' ? h('div', { class: 'stat-value' }, value) : value);

// ---------------- Today (dashboard) ----------------

interface Today {
  status: { name: string; power: string; attention: string; devicesOnline: number; spendToday?: { spent: number; limit: number } };
  briefing: { text: string } | null;
  situation: { facts: string[]; anomalies: { severity: string; message: string; suggestion?: string }[] };
  approvals: { id: string; preview: { title: string } }[];
  goals: { id: string; title: string; horizon: string; progress: number; status: string }[];
  forecasts: { id: string; statement: string; probability: number; resolveBy: number }[];
  notifications: { title: string; body: string; at: number }[];
}

export function todayScreen(): Node {
  return h('div', { class: 'page' }, pageHead('Today'),
    view<Today>(() => api('/today'), (d) => {
      const sp = d.status.spendToday;
      return h('div', { class: 'col', style: 'gap: var(--space-4)' },
        d.briefing ? card(h('div', { class: 'row', style: 'gap: var(--space-2); margin-bottom: 8px' }, icon('spark'), h('strong', {}, 'Briefing')), h('div', { class: 'muted', style: 'white-space: pre-wrap; line-height: 1.6' }, d.briefing.text)) : false,
        h('div', { class: 'card-grid' },
          stat('Spend today', sp ? `${usd(sp.spent)} / ${usd(sp.limit)}` : '—'),
          stat('Devices online', String(d.status.devicesOnline)),
          stat('Power mode', d.status.power),
          stat('Attention', d.status.attention),
        ),
        d.situation.anomalies.length ? card(h('strong', {}, 'Needs attention'), ...d.situation.anomalies.map((a) => h('div', { class: 'row', style: 'margin-top: 8px; gap: 8px' }, h('span', { class: `status-dot ${a.severity === 'critical' ? 'offline' : 'connecting'}` }), h('span', { class: 'grow' }, a.message), a.suggestion ? h('span', { class: 'faint' }, a.suggestion) : false))) : false,
        d.approvals.length ? card(h('div', { class: 'row' }, icon('shield'), h('strong', { class: 'grow' }, `${d.approvals.length} waiting for you`), h('button', { class: 'btn sm', on: { click: () => navigate('chat') } }, 'Review')), ...d.approvals.slice(0, 4).map((a) => h('div', { class: 'muted', style: 'margin-top: 6px' }, a.preview.title))) : false,
        d.goals.length ? card(h('div', { class: 'row', style: 'margin-bottom: 10px' }, h('strong', { class: 'grow' }, 'Goals'), h('button', { class: 'btn sm ghost', on: { click: () => navigate('goals') } }, 'All')), ...d.goals.slice(0, 5).map(goalRow)) : false,
        d.forecasts.length ? card(h('strong', {}, 'Predictions in play'), ...d.forecasts.slice(0, 5).map((f) => h('div', { class: 'row', style: 'margin-top: 8px; gap: 10px' }, h('span', { class: 'pill accent tnum' }, `${Math.round(f.probability * 100)}%`), h('span', { class: 'grow' }, f.statement), h('span', { class: 'faint' }, timeAgo(f.resolveBy))))) : false,
      );
    }, ['run.approval', 'run.status', 'notification', 'power']),
  );
}

const goalRow = (g: { id: string; title: string; horizon: string; progress: number; status: string }) =>
  h('div', { class: 'col', style: 'gap: 6px; margin-top: 10px' },
    h('div', { class: 'row', style: 'gap: 8px' }, h('span', { class: 'pill' }, g.horizon), h('span', { class: 'grow' }, g.title), g.status === 'proposed' ? h('span', { class: 'pill accent' }, 'proposed') : h('span', { class: 'faint tnum' }, `${Math.round(g.progress * 100)}%`)),
    h('div', { class: 'meter' }, h('span', { style: `width: ${Math.round(g.progress * 100)}%` })));

// ---------------- Mind ----------------

export function mindScreen(): Node {
  return h('div', { class: 'page' }, pageHead('Mind', 'How Feroxes thinks, and how that is changing.'),
    view<any>(() => api('/mind'), (d) => h('div', { class: 'col', style: 'gap: var(--space-4)' },
      card(h('div', { class: 'row', style: 'margin-bottom: 8px' }, icon('mind'), h('strong', { class: 'grow' }, `Self-model v${d.self.version}`), h('span', { class: 'faint' }, `${d.versions.length} versions`)),
        h('div', { class: 'muted', style: 'white-space: pre-wrap; line-height: 1.6; font-size: var(--text-sm)' }, renderSelf(d.self))),
      d.growth ? card(h('strong', {}, 'Growth (7 days)'), h('div', { class: 'muted', style: 'white-space: pre-wrap; margin-top: 8px; line-height: 1.6' }, d.growth)) : false,
      card(h('strong', {}, 'Thinking quality (7 days)'),
        h('div', { class: 'card-grid', style: 'margin-top: 12px' },
          stat('Success', `${Math.round((d.quality.successRate ?? 0) * 100)}%`),
          stat('Corrections', String(d.quality.corrections)),
          stat('Loops caught', String(d.quality.loopsCaught)),
          stat('Forecast Brier', d.calibration.brier ?? '—'))),
      d.beliefs.length ? card(h('strong', {}, 'Cause & effect it has learned'), ...d.beliefs.slice(0, 8).map((b: any) => h('div', { class: 'row', style: 'margin-top: 8px; gap: 8px' }, h('span', { class: 'pill accent tnum' }, `${Math.round(b.confidence * 100)}%`), h('span', { class: 'grow' }, `${b.cause} → ${b.effect}`), h('span', { class: 'faint' }, b.domain)))) : false,
      d.research.length ? card(h('strong', {}, 'Research'), ...d.research.map((c: any) => h('div', { class: 'row', style: 'margin-top: 8px' }, h('span', { class: `pill ${c.status === 'done' ? 'ok' : 'accent'}` }, c.status), h('span', { class: 'grow' }, c.question)))) : false,
      d.improvements.length ? card(h('strong', {}, 'Improvements it proposes'), ...d.improvements.map((p: any) => h('div', { class: 'muted', style: 'margin-top: 6px' }, `• ${p.text}`))) : false,
    )),
  );
}

const renderSelf = (s: any) => [`${s.identity.role}`, `Values: ${s.values.slice(0, 3).join('; ')}`, s.currentFocus?.length ? `Focus: ${s.currentFocus.join(', ')}` : '', s.lessons?.length ? `Recent lesson: ${s.lessons.at(-1)}` : ''].filter(Boolean).join('\n');

// ---------------- Memory ----------------

export function memoryScreen(): Node {
  const q = signal('');
  const results = signal<any[] | null>(null);
  const run = async () => results.set(await api(`/memories${q.peek() ? `?q=${encodeURIComponent(q.peek())}` : ''}`));
  run();
  const host = h('div', { class: 'page' }, pageHead('Memory', 'Everything Feroxes remembers about you. Edit or delete anything.'),
    h('div', { class: 'field', style: 'margin-bottom: var(--space-4); display: flex; gap: 8px; align-items: center' }, icon('search'),
      h('input', { placeholder: 'Search memories…', style: 'border: none; background: none; width: 100%', on: { input: (e: Event) => { q.set((e.target as HTMLInputElement).value); run(); } } })),
    h('div', { class: 'grow' }));
  append(host.lastChild as Node, [() => (results() === null ? skeleton() : (results() as any[]).length === 0 ? h('div', { class: 'empty' }, 'No memories yet.') : (results() as any[]).map(memRow))]);
  return host;
}

const memRow = (m: any) => h('div', { class: 'card', style: 'padding: var(--space-3) var(--space-4); margin-bottom: 8px' },
  h('div', { class: 'row', style: 'gap: 8px' }, h('span', { class: 'pill' }, m.kind), m.pinned ? h('span', { class: 'pill accent' }, 'pinned') : false, m.sensitivity !== 'normal' ? h('span', { class: 'pill warn' }, m.sensitivity) : false, h('span', { class: 'grow' }), h('span', { class: 'faint mono', style: 'font-size: var(--text-xs)' }, `m:${String(m.id).slice(-8)}`)),
  h('div', { style: 'margin-top: 6px' }, m.content));

// ---------------- Goals ----------------

export function goalsScreen(): Node {
  return h('div', { class: 'page' }, pageHead('Goals', 'Feroxes proposes; you decide what it works toward.'),
    view<{ goals: any[] }>(() => api('/goals'), (d, reload) => {
      const act = async (id: string, body: any) => { await api(`/goals/${id}`, { body }); reload(); };
      const active = d.goals.filter((g) => g.status === 'active');
      const proposed = d.goals.filter((g) => g.status === 'proposed');
      return h('div', { class: 'col', style: 'gap: var(--space-4)' },
        proposed.length ? card(h('strong', {}, 'Proposed for you'), ...proposed.map((g) => h('div', { class: 'row', style: 'margin-top: 10px; gap: 8px' }, h('span', { class: 'pill' }, g.horizon), h('span', { class: 'grow' }, g.title), h('button', { class: 'btn sm primary', on: { click: () => act(g.id, { status: 'active' }) } }, 'Accept'), h('button', { class: 'btn sm ghost', on: { click: () => act(g.id, { status: 'dropped' }) } }, 'Dismiss')))) : false,
        card(h('strong', {}, `Active (${active.length})`), active.length ? h('div', {}, ...active.map(goalRow)) : h('div', { class: 'faint', style: 'margin-top: 8px' }, 'No active goals.')),
      );
    }),
  );
}

// ---------------- Devices ----------------

export function devicesScreen(): Node {
  return h('div', { class: 'page' }, pageHead('Devices', 'Your PC and phone, treated as one body.'),
    view<any[]>(() => api('/devices'), (list_, reload) => h('div', { class: 'col', style: 'gap: var(--space-4)' },
      h('div', {}, h('button', { class: 'btn primary', on: { click: async () => { const r = await api<{ code: string }>('/devices/pair', { body: {} }); toast({ title: 'Pairing code', body: `Enter ${r.code} in the Feroxes app on the device`, urgency: 'normal' }); } } }, icon('plus'), 'Pair a device')),
      list_.length === 0 ? h('div', { class: 'empty' }, 'No devices paired yet.') : h('div', { class: 'card-grid' }, ...list_.map((dv) => card(
        h('div', { class: 'row', style: 'gap: 8px' }, icon(dv.kind === 'phone' ? 'phone' : 'pc'), h('strong', { class: 'grow' }, dv.name), h('span', { class: `status-dot ${dv.online ? 'online' : 'offline'}` })),
        h('div', { class: 'faint', style: 'margin-top: 8px; font-size: var(--text-sm)' }, `${dv.platform} · ${dv.capabilities.length} capabilities`),
        dv.state?.battery ? h('div', { class: 'muted', style: 'margin-top: 4px' }, `Battery ${dv.state.battery.percent}%`) : false,
        h('button', { class: 'btn sm ghost danger', style: 'margin-top: 12px', on: { click: async () => { await api(`/devices/${dv.id}`, { method: 'DELETE' }); reload(); } } }, 'Unpair')))),
    ), ['event']),
  );
}

// ---------------- Usage ----------------

export function usageScreen(): Node {
  return h('div', { class: 'page' }, pageHead('Usage & budgets'),
    view<any>(() => api('/usage'), (d) => h('div', { class: 'col', style: 'gap: var(--space-4)' },
      ...d.budgets.map((b: any) => card(
        h('div', { class: 'row' }, h('strong', { class: 'grow' }, b.budget.name), h('span', { class: 'tnum muted' }, `${usd(b.counter.spent)} / ${usd(b.budget.limit)}`)),
        h('div', { class: `meter ${b.percent >= 95 ? 'danger' : b.percent >= 80 ? 'warn' : ''}`, style: 'margin-top: 10px' }, h('span', { style: `width: ${Math.min(100, b.percent)}%` })))),
      card(h('strong', {}, 'By model (30 days)'), ...d.byModel.map((m: any) => h('div', { class: 'row', style: 'margin-top: 8px' }, h('span', { class: 'grow mono', style: 'font-size: var(--text-sm)' }, m.key), h('span', { class: 'faint' }, `${m.calls} calls`), h('span', { class: 'tnum', style: 'margin-left: 12px' }, usd(m.cost))))),
    )),
  );
}

// ---------------- Settings ----------------

export function settingsScreen(): Node {
  return h('div', { class: 'page page-narrow' }, pageHead('Settings', 'AI providers, values and appearance.'),
    h('section', { id: 'providers', class: 'col', style: 'gap: var(--space-3); margin-bottom: var(--space-6)' }, h('h2', { class: 'section-title' }, 'Providers'), providersSection()),
    view<any>(() => api('/mind'), (d) => h('div', { class: 'col', style: 'gap: var(--space-4)' },
      card(h('strong', {}, 'Values (only you can change these)'), h('div', { class: 'col', style: 'gap: 6px; margin-top: 10px' }, ...d.self.values.map((v: string) => h('div', { class: 'row', style: 'gap: 8px' }, icon('check', 15), h('span', {}, v))))),
      card(h('strong', {}, 'Boundaries'), h('div', { class: 'col', style: 'gap: 6px; margin-top: 10px' }, ...d.self.boundaries.map((v: string) => h('div', { class: 'row', style: 'gap: 8px' }, icon('lock', 15), h('span', {}, v))))),
      card(h('strong', {}, 'Theme'),
        h('div', { class: 'row', style: 'gap: 8px; margin-top: 10px' },
          ...(['dark', 'light', 'system'] as const).map((t) => h('button', { class: 'btn sm', on: { click: () => setTheme(t) } }, t)))),
    )),
  );
}

export function setTheme(t: 'dark' | 'light' | 'system'): void {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  localStore.setItem('feroxes-theme', t);
}

export type { Signal };
