import { api, bootError, localStore } from './api.ts';
import { chatScreen } from './chat.ts';
import { type Signal, h, list, signal, transition } from './core.ts';
import { icon } from './icons.ts';
import { devicesScreen, goalsScreen, memoryScreen, mindScreen, setTheme, settingsScreen, todayScreen, usageScreen } from './screens.ts';
import { connect, connection, navigate, route, status, toast, toasts } from './store.ts';

const NAV = [
  { id: 'today', label: 'Today', icon: 'today' },
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'mind', label: 'Mind', icon: 'mind' },
  { id: 'memory', label: 'Memory', icon: 'memory' },
  { id: 'goals', label: 'Goals', icon: 'goals' },
  { id: 'devices', label: 'Devices', icon: 'devices' },
  { id: 'usage', label: 'Usage', icon: 'activity' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
] as const;

const SCREENS: Record<string, () => Node> = { today: todayScreen, chat: chatScreen, mind: mindScreen, memory: memoryScreen, goals: goalsScreen, devices: devicesScreen, usage: usageScreen, settings: settingsScreen };

const paletteOpen = signal(false);

function rail(): Node {
  return h('nav', { class: 'rail' },
    h('div', { class: 'rail-brand' },
      h('div', { class: 'rail-logo' }),
      h('div', { class: 'col' }, h('span', { class: 'rail-name' }, () => status()?.name ?? 'Feroxes'), h('span', { class: 'rail-sub' }, () => (status() ? `v${status()!.selfVersion} · start #${status()!.boots}` : 'connecting…'))),
    ),
    ...NAV.map((n) =>
      h('a', { class: 'nav-item', href: `#${n.id}`, 'aria-current': () => (route() === n.id ? 'page' : false), on: { click: (e: Event) => { e.preventDefault(); navigate(n.id); } } },
        icon(n.icon), h('span', { class: 'grow' }, n.label),
        n.id === 'chat' ? h('span', { class: () => `nav-badge${(status()?.approvals ?? 0) > 0 ? ' danger' : ''}`, style: () => ((status()?.approvals ?? 0) > 0 ? '' : 'display:none') }, () => String(status()?.approvals ?? 0)) : false),
    ),
    h('div', { class: 'rail-spacer' }),
    h('button', { class: 'nav-item', on: { click: () => (paletteOpen.set(true)) } }, icon('search'), h('span', { class: 'grow' }, 'Command'), h('kbd', { class: 'faint', style: 'font-size: var(--text-xs)' }, '⌘K')),
  );
}

function topbar(): Node {
  const dotClass = () => `status-dot ${connection()}`;
  const stopped = () => status()?.state === 'stopped';
  return h('header', { class: 'topbar' },
    h('span', { class: 'topbar-title' }, () => NAV.find((n) => n.id === route())?.label ?? 'Feroxes'),
    h('span', { class: 'topbar-spacer' }),
    h('span', { class: 'pill', title: () => `power: ${status()?.power ?? '—'}` }, () => status()?.power === 'economy' ? 'economy' : status()?.attention ?? ''),
    h('span', { class: () => dotClass(), title: () => connection() }),
    h('button', { class: 'btn icon-btn ghost', 'aria-label': 'Toggle theme', on: { click: toggleTheme } }, themeIcon()),
    h('button', {
      class: () => `btn sm ${stopped() ? 'primary' : 'stop-btn'}`,
      on: { click: async () => {
        const s = status()?.state === 'stopped';
        await api(s ? '/system/resume' : '/system/stop', { body: { reason: 'app' } }).catch((e) => toast({ title: 'Failed', body: (e as Error).message, urgency: 'high' }));
      } },
    }, () => (stopped() ? [icon('play', 15), ' Resume'] : [icon('stop', 15), ' Stop'])),
  );
}

function themeIcon(): Node {
  const dark = !document.documentElement.getAttribute('data-theme') || document.documentElement.getAttribute('data-theme') === 'dark';
  return icon(dark ? 'moon' : 'sun');
}
function toggleTheme(): void {
  const cur = document.documentElement.getAttribute('data-theme') ?? 'dark';
  setTheme(cur === 'dark' ? 'light' : 'dark');
  location.reload(); // simplest way to refresh the theme icon; instant via CSS variables
}

function palette(): Node {
  const query = signal('');
  const commands = [
    ...NAV.map((n) => ({ label: `Go to ${n.label}`, run: () => navigate(n.id), kbd: '' })),
    { label: 'Stop Feroxes', run: () => void api('/system/stop', { body: { reason: 'palette' } }), kbd: '' },
    { label: 'New briefing', run: () => void api('/briefing', { body: {} }).then((r: any) => toast({ title: 'Briefing', body: r.text?.slice(0, 160), urgency: 'normal' })), kbd: '' },
    { label: 'Pair a device', run: () => void api('/devices/pair', { body: {} }).then((r: any) => toast({ title: 'Pairing code', body: r.code, urgency: 'normal' })), kbd: '' },
    { label: 'Economy mode', run: () => void api('/system/power', { body: { mode: 'economy' } }), kbd: '' },
    { label: 'Silent (observe only)', run: () => void api('/attention', { body: { mode: 'silent' } }), kbd: '' },
  ];
  const filtered = () => commands.filter((c) => c.label.toLowerCase().includes(query().toLowerCase()));
  const sel = signal(0);
  const close = () => { paletteOpen.set(false); query.set(''); sel.set(0); };
  const choose = (i: number) => { filtered()[i]?.run(); close(); };
  const input = h('input', { class: 'palette-input', placeholder: 'Type a command…', 'aria-label': 'Command',
    on: { input: (e: Event) => { query.set((e.target as HTMLInputElement).value); sel.set(0); },
      keydown: (e: KeyboardEvent) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); sel.update((s) => Math.min(filtered().length - 1, s + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); sel.update((s) => Math.max(0, s - 1)); }
        else if (e.key === 'Enter') choose(sel.peek());
        else if (e.key === 'Escape') close();
      } } }) as HTMLInputElement;
  queueMicrotask(() => input.focus());
  return h('div', {},
    h('div', { class: 'scrim', on: { click: close } }),
    h('div', { class: 'palette', role: 'dialog' }, input,
      h('div', { class: 'palette-list' },
        list(() => filtered().map((c, i) => ({ ...c, i })), (c) => c.label, (c) =>
          h('div', { class: 'palette-item', 'aria-selected': () => (sel() === c().i ? 'true' : 'false'), on: { click: () => choose(c().i), mouseenter: () => sel.set(c().i) } }, icon('chevron', 14), h('span', { class: 'grow' }, () => c().label))))),
  );
}

function bootErrorScreen(root: HTMLElement, message: string): void {
  root.replaceChildren(
    h('div', { class: 'boot-error' },
      h('div', { class: 'boot-error-card' },
        h('div', { class: 'boot-error-logo' }),
        h('h1', {}, 'Feroxes could not start its brain'),
        h('p', { class: 'muted' }, message),
        h('p', { class: 'muted sm' }, 'Check that the Core service can run, then reopen Feroxes. You can also start it from a terminal with ', h('code', {}, 'feroxes serve'), '.'),
      ),
    ),
  );
  root.removeAttribute('aria-busy');
}

function boot(): void {
  const root = document.getElementById('app')!;
  const saved = localStore.getItem('feroxes-theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
  if (bootError) return bootErrorScreen(root, bootError);
  connect();

  // Keep the badge count fresh on load.
  void api('/status').then((s) => status.set(s as never)).catch(() => {});

  const screenHost = h('main', { class: 'content' });
  let current = '';
  const mount = () => {
    const r = route();
    if (r === current) return;
    current = r;
    const make = SCREENS[r] ?? todayScreen;
    transition(() => {
      screenHost.replaceChildren(make());
    });
  };
  // Re-mount on route change.
  (function watch() { let last = ''; setInterval(() => { if (route.peek() !== last) { last = route.peek(); mount(); } }, 16); })();
  mount();

  root.replaceChildren(
    h('div', {},
      () => (status()?.state === 'stopped' ? h('div', { class: 'stopped-banner' }, 'Feroxes is stopped — nothing runs until you resume') : false),
      h('div', { class: 'shell' }, rail(), h('div', { class: 'main' }, topbar(), screenHost)),
      () => (paletteOpen() ? palette() : false),
      h('div', { class: 'toasts' }, list(() => toasts(), (t) => String(t.id), (t) =>
        h('div', { class: () => `toast ${t().urgency}` }, icon(t().urgency === 'high' ? 'shield' : 'spark'), h('div', { class: 'grow' }, h('div', { class: 'toast-title' }, () => t().title), () => (t().body ? h('div', { class: 'toast-body' }, t().body!) : false))))),
    ),
  );
  root.removeAttribute('aria-busy');

  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); paletteOpen.update((v) => !v); }
  });
}

boot();
export type { Signal };
