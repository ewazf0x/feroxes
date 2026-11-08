import { api } from './api.ts';
import { type Signal, append, h, signal, timeAgo } from './core.ts';
import { icon } from './icons.ts';
import { on, toast } from './store.ts';

/**
 * Integrations: connect accounts, choose what Feroxes may do with each, see health and activity.
 * Secrets are typed into password fields and sent once to the local Core, which seals them in the
 * vault; nothing secret is ever shown again or kept in the page.
 */
type Field = { key: string; label: string; secret: boolean; placeholder?: string; help?: string; optional?: boolean };
type Capability = { id: string; label: string; description: string; default: boolean };
type Connection = { id: string; accountName: string; status: 'connected' | 'needs_reauth' | 'error' | 'rate_limited'; enabledCapabilities: string[]; lastOkAt?: number; lastCheckedAt?: number; lastError?: string; createdAt: number; expiresAt?: number };
type Summary = {
  id: string;
  name: string;
  category: 'social' | 'productivity' | 'developer';
  docsUrl: string;
  authKind: 'oauth2' | 'token' | 'none';
  fields: Field[];
  appFields: Field[];
  appConfigured: boolean;
  redirectUri?: string;
  capabilities: Capability[];
  limitations: string[];
  setupSteps: string[];
  actions: { name: string; capability: string; category: string; description: string }[];
  connections: Connection[];
};
type Activity = { seq: number; ts: number; action: string; category?: string; decision: string; outcome: string; summary: string };

const CATEGORY_LABEL = { social: 'Social', productivity: 'Productivity', developer: 'Developer tools' } as const;
const STATUS: Record<Connection['status'], [string, string]> = { connected: ['online', 'Connected'], needs_reauth: ['danger', 'Reconnect needed'], error: ['warning', 'Error'], rate_limited: ['warning', 'Rate limited'] };
const MONOGRAM: Record<string, string> = { instagram: 'IG', discord: 'Dc', telegram: 'Tg', whatsapp: 'WA', slack: 'Sl', reddit: 'Rd', google: 'G', outlook: 'Ol', notion: 'N', github: 'GH', gitlab: 'GL', vscode: 'VS' };

export function integrationsScreen(): Node {
  const data = signal<Summary[] | null>(null);
  const error = signal('');
  const filter = signal<'all' | Summary['category']>('all');
  const openId = signal<string | null>(null);
  const load = () => api<Summary[]>('/connectors').then((d) => data.set(d)).catch((e) => error.set((e as Error).message));
  load();
  on('connector', () => load());

  const page = h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, 'Integrations'), h('p', { class: 'page-desc' }, 'Connect your accounts and decide exactly what Feroxes may do with each. Sending, publishing and deleting always follow your approval settings.')),
  );
  append(page, [
    () => {
      if (error()) return h('div', { class: 'empty' }, `Couldn't load integrations: ${error()}`);
      const all = data();
      if (!all) return h('div', { class: 'card-grid' }, ...Array.from({ length: 6 }, () => h('div', { class: 'card' }, h('div', { class: 'skeleton', style: 'height: 14px; width: 40%' }), h('div', { class: 'skeleton', style: 'height: 28px; width: 70%; margin-top: 12px' }))));
      const connected = all.reduce((n, c) => n + c.connections.length, 0);
      const attention = all.flatMap((c) => c.connections).filter((x) => x.status !== 'connected').length;
      const shown = all.filter((c) => filter() === 'all' || c.category === filter());
      return h('div', { class: 'col', style: 'gap: var(--space-5)' },
        h('div', { class: 'row integ-toolbar' },
          h('div', { class: 'segmented', role: 'tablist' }, ...(['all', 'social', 'productivity', 'developer'] as const).map((f) => h('button', { class: () => `seg${filter() === f ? ' on' : ''}`, role: 'tab', 'aria-selected': () => (filter() === f ? 'true' : 'false'), on: { click: () => filter.set(f) } }, f === 'all' ? 'All' : CATEGORY_LABEL[f]))),
          h('span', { class: 'grow' }),
          h('span', { class: 'muted', style: 'font-size: var(--text-sm)' }, `${connected} connected${attention ? ` · ${attention} need attention` : ''}`),
        ),
        h('div', { class: 'card-grid integ-grid' }, ...shown.map((c) => tile(c, () => openId.set(c.id)))),
      );
    },
    () => {
      const id = openId();
      const c = id ? data()?.find((x) => x.id === id) : undefined;
      return c ? drawer(c, () => openId.set(null), load) : false;
    },
  ]);
  return page;
}

function tile(c: Summary, open: () => void): Node {
  const conn = c.connections[0];
  const st = conn ? STATUS[conn.status] : null;
  return h('button', { class: 'card integ-tile', on: { click: open }, 'aria-label': `${c.name}: ${st ? st[1] : 'not connected'}` },
    h('div', { class: 'row', style: 'gap: 12px' },
      h('span', { class: `integ-logo logo-${c.id}` }, MONOGRAM[c.id] ?? c.name[0]!),
      h('div', { class: 'col grow', style: 'min-width: 0' },
        h('strong', {}, c.name),
        h('span', { class: 'faint', style: 'font-size: var(--text-sm)' }, conn ? (c.connections.length > 1 ? `${c.connections.length} accounts` : conn.accountName) : CATEGORY_LABEL[c.category]),
      ),
      st ? h('span', { class: `pill status-pill ${st[0]}` }, h('span', { class: `status-dot ${st[0] === 'online' ? 'online' : 'offline'}` }), st[1]) : h('span', { class: 'pill' }, 'Connect'),
    ),
  );
}

function drawer(c: Summary, close: () => void, reload: () => void): Node {
  const busy = signal(false);
  const values: Record<string, string> = {};
  const caps: Signal<string[]> = signal(c.capabilities.filter((k) => k.default).map((k) => k.id));
  const activity = signal<Activity[] | null>(null);
  api<Activity[]>(`/connectors/${c.id}/activity`).then((a) => activity.set(a)).catch(() => activity.set([]));
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  window.addEventListener('keydown', onKey, { once: true });

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    busy.set(true);
    try {
      await fn();
      if (ok) toast({ title: ok, urgency: 'normal' });
      reload();
    } catch (e) {
      toast({ title: `${c.name}`, body: (e as Error).message, urgency: 'high' });
    } finally {
      busy.set(false);
    }
  };

  const fieldInput = (f: Field) =>
    h('label', { class: 'form-field' },
      h('span', { class: 'form-label' }, f.label, f.optional ? h('span', { class: 'faint' }, ' (optional)') : false),
      h('input', { class: 'input', type: f.secret ? 'password' : 'text', autocomplete: 'off', spellcheck: 'false', placeholder: f.placeholder ?? '', on: { input: (e: Event) => (values[f.key] = (e.target as HTMLInputElement).value) } }),
      f.help ? h('span', { class: 'form-help' }, f.help) : false,
    );

  const capToggles = (current: string[], onChange: (next: string[]) => void) =>
    h('div', { class: 'col', style: 'gap: 2px' }, ...c.capabilities.map((k) => {
      const actions = c.actions.filter((a) => a.capability === k.id);
      const outward = actions.some((a) => a.category !== 'read');
      return h('label', { class: 'toggle-row' },
        h('input', { type: 'checkbox', checked: current.includes(k.id), on: { change: (e: Event) => onChange((e.target as HTMLInputElement).checked ? [...current, k.id] : current.filter((x) => x !== k.id)) } }),
        h('span', { class: 'toggle' }),
        h('span', { class: 'col grow' }, h('span', {}, k.label, outward ? h('span', { class: 'pill tiny' }, 'asks first') : false), k.description ? h('span', { class: 'faint', style: 'font-size: var(--text-sm)' }, k.description) : false),
      );
    }));

  const connectForm = () => {
    if (c.authKind === 'none') return h('p', { class: 'muted' }, 'Runs on this PC; nothing to sign in to.');
    if (c.authKind === 'oauth2' && !c.appConfigured)
      return h('div', { class: 'col', style: 'gap: 12px' },
        h('p', { class: 'muted' }, `Feroxes runs on your PC, so it signs in through your own ${c.name} app. Register it once:`),
        h('ol', { class: 'steps' }, ...c.setupSteps.map((s) => h('li', {}, s))),
        c.redirectUri ? h('div', { class: 'form-field' }, h('span', { class: 'form-label' }, 'Redirect URI to register'), h('code', { class: 'copyable', on: { click: () => void navigator.clipboard?.writeText(c.redirectUri!).then(() => toast({ title: 'Copied', urgency: 'low' })) } }, c.redirectUri)) : false,
        ...c.appFields.map(fieldInput),
        h('button', { class: 'btn primary', disabled: () => busy(), on: { click: () => run(() => api(`/connectors/${c.id}/app`, { body: { fields: values } }), 'App saved') } }, 'Save app'),
      );
    return h('div', { class: 'col', style: 'gap: 12px' },
      c.authKind === 'token' ? h('ol', { class: 'steps' }, ...c.setupSteps.map((s) => h('li', {}, s))) : false,
      ...(c.authKind === 'token' ? c.fields.map(fieldInput) : []),
      h('div', { class: 'form-label' }, 'What Feroxes may do'),
      capToggles(caps.peek(), (next) => caps.set(next)),
      h('button', {
        class: 'btn primary',
        disabled: () => busy(),
        on: {
          click: () =>
            run(async () => {
              const r = await api<{ authorizeUrl?: string }>(`/connectors/${c.id}/connect`, { body: { fields: values, capabilities: caps.peek() } });
              if (r.authorizeUrl) {
                window.open(r.authorizeUrl, '_blank', 'noopener');
                toast({ title: `Finish signing in to ${c.name} in your browser`, urgency: 'normal' });
              }
            }, c.authKind === 'token' ? `${c.name} connected` : undefined),
        },
      }, icon('plus', 15), c.authKind === 'oauth2' ? ` Sign in with ${c.name}` : ' Connect'),
    );
  };

  const account = (x: Connection) => {
    const st = STATUS[x.status];
    return h('div', { class: 'card inset col', style: 'gap: 12px' },
      h('div', { class: 'row', style: 'gap: 10px' },
        h('span', { class: `status-dot ${st[0] === 'online' ? 'online' : 'offline'}` }),
        h('strong', { class: 'grow' }, x.accountName),
        h('span', { class: `pill status-pill ${st[0]}` }, st[1]),
      ),
      h('div', { class: 'faint', style: 'font-size: var(--text-sm)' }, `Connected ${timeAgo(x.createdAt)}${x.lastOkAt ? ` · last OK ${timeAgo(x.lastOkAt)}` : ''}${x.expiresAt ? ` · token renews ${timeAgo(x.expiresAt)}` : ''}`),
      x.lastError && x.status !== 'connected' ? h('div', { class: 'callout danger' }, x.lastError) : false,
      capToggles(x.enabledCapabilities, (next) => void run(() => api(`/connections/${x.id}/capabilities`, { body: { capabilities: next } }), 'Permissions updated')),
      h('div', { class: 'row', style: 'gap: 8px' },
        h('button', { class: 'btn sm', disabled: () => busy(), on: { click: () => run(() => api(`/connections/${x.id}/check`, { body: {} }), 'Checked') } }, icon('refresh', 14), ' Test'),
        x.status === 'needs_reauth' && c.authKind === 'oauth2' ? h('button', { class: 'btn sm primary', on: { click: () => run(async () => { const r = await api<{ authorizeUrl?: string }>(`/connectors/${c.id}/connect`, { body: { capabilities: x.enabledCapabilities } }); if (r.authorizeUrl) window.open(r.authorizeUrl, '_blank', 'noopener'); }) } }, 'Reconnect') : false,
        h('span', { class: 'grow' }),
        h('button', { class: 'btn sm ghost danger', disabled: () => busy(), on: { click: () => confirm(`Disconnect ${x.accountName}? Feroxes revokes access where ${c.name} allows it and deletes the stored credentials.`) && void run(() => api(`/connections/${x.id}`, { method: 'DELETE' }), 'Disconnected') } }, 'Disconnect'),
      ),
    );
  };

  return h('div', {},
    h('div', { class: 'scrim', on: { click: close } }),
    h('aside', { class: 'drawer', role: 'dialog', 'aria-label': `${c.name} integration` },
      h('div', { class: 'drawer-head row' },
        h('span', { class: `integ-logo logo-${c.id}` }, MONOGRAM[c.id] ?? c.name[0]!),
        h('div', { class: 'col grow' }, h('strong', { style: 'font-size: var(--text-md)' }, c.name), h('a', { class: 'faint', href: c.docsUrl, target: '_blank', rel: 'noopener', style: 'font-size: var(--text-sm)' }, 'Official API docs')),
        h('button', { class: 'btn icon-btn ghost', 'aria-label': 'Close', on: { click: close } }, icon('x')),
      ),
      h('div', { class: 'drawer-body col', style: 'gap: var(--space-5)' },
        c.connections.length ? h('section', { class: 'col', style: 'gap: 10px' }, h('h3', { class: 'section-title' }, 'Accounts'), ...c.connections.map(account)) : false,
        h('section', { class: 'col', style: 'gap: 10px' }, h('h3', { class: 'section-title' }, c.connections.length ? 'Add another account' : 'Connect'), connectForm()),
        h('section', { class: 'col', style: 'gap: 8px' }, h('h3', { class: 'section-title' }, 'What the official API allows'), h('ul', { class: 'limits' }, ...c.limitations.map((l) => h('li', {}, l)))),
        h('section', { class: 'col', style: 'gap: 8px' },
          h('h3', { class: 'section-title' }, 'Activity'),
          () => {
            const a = activity();
            if (!a) return h('div', { class: 'skeleton', style: 'height: 40px' });
            if (!a.length) return h('p', { class: 'faint' }, 'Nothing yet. Every connection change and every action Feroxes takes here is recorded in the audit log.');
            return h('div', { class: 'activity' }, ...a.slice(0, 25).map((e) => h('div', { class: 'activity-row' }, h('span', { class: `dot ${e.outcome === 'success' ? 'ok' : e.outcome === 'pending' ? 'wait' : 'bad'}` }), h('span', { class: 'grow' }, e.summary), h('span', { class: 'faint' }, timeAgo(e.ts)))));
          },
        ),
      ),
    ),
  );
}
