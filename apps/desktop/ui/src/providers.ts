import { api } from './api.ts';
import { append, h, signal, timeAgo, usd } from './core.ts';
import { icon } from './icons.ts';
import { on, toast } from './store.ts';

/**
 * Settings → Providers: add an AI provider, choose its models and tiers, test it for real, and
 * pick the chat model. API keys are sent once to the local Core (sealed in the vault) and only a
 * masked hint is shown afterwards.
 */
type Tier = 'fast' | 'balanced' | 'frontier' | 'local';
type ModelCfg = { key: string; tier: Tier; enabled: boolean; label?: string; contextWindow?: number; price?: { input: number; output: number; source: 'provider' | 'owner' } };
type Test = { at: number; ok: boolean; auth: string; modelsAvailable?: number; model?: string; latencyMs?: number; reply?: string; tokens?: { input: number; output: number }; costNanoUsd?: number; error?: string };
type Kiro = { command?: string; agent?: string; useLogin: boolean; acknowledgedTerms?: number; status?: { installed: boolean; command: string; version?: string; authenticated: boolean; method?: string; detail?: string; error?: string } };
type P = { id: string; name: string; keyLabel?: string; keyRequired: boolean; keyPlaceholder?: string; keyUrl?: string; baseUrlEditable: boolean; docsUrl: string; notes: string[]; enabled: boolean; hasKey: boolean; keyHint?: string; baseUrl?: string; models: ModelCfg[]; defaultModel?: string; kiro?: Kiro; lastTest?: Test; status: 'off' | 'incomplete' | 'untested' | 'connected' | 'error' };
type Summary = { chatModel: { providerId: string; modelKey: string; providerName: string } | null; routedTiers: Record<Tier, string[]>; cautiousPrice: { input: number; output: number }; kiroTermsNotice: string; providers: P[] };
type Found = { key: string; label?: string; contextWindow?: number; price?: { input: number; output: number }; chat: boolean };

const TIERS: Tier[] = ['fast', 'balanced', 'frontier', 'local'];
const TIER_HELP: Record<Tier, string> = { fast: 'quick, cheap: memory, summaries', balanced: 'everyday chat and planning', frontier: 'hardest reasoning', local: 'private, on this PC' };
const MONO: Record<string, string> = { openai: 'AI', anthropic: 'An', google: 'G', openrouter: 'OR', ollama: 'Ol', kiro: 'K' };
const STATUS: Record<P['status'], [string, string]> = { off: ['', 'Off'], incomplete: ['warn', 'Set up needed'], untested: ['accent', 'Not tested'], connected: ['ok', 'Connected'], error: ['danger', 'Error'] };

export function providersSection(): Node {
  const data = signal<Summary | null>(null);
  const openId = signal<string | null>(null);
  const load = () => api<Summary>('/providers').then((d) => data.set(d)).catch((e) => toast({ title: 'Providers', body: (e as Error).message, urgency: 'high' }));
  load();
  on('providers', () => load());
  const host = h('div', { class: 'col', style: 'gap: var(--space-4)' });
  append(host, [
    () => {
      const d = data();
      if (!d) return h('div', { class: 'card' }, h('div', { class: 'skeleton', style: 'height: 60px' }));
      const using = d.chatModel;
      return h('div', { class: 'card col', style: 'gap: var(--space-4)' },
        h('div', { class: 'row', style: 'gap: 10px' },
          h('div', { class: 'col grow' }, h('strong', {}, 'AI providers'), h('span', { class: 'muted', style: 'font-size: var(--text-sm)' }, using ? ['Chat uses ', h('b', {}, using.modelKey), ` on ${using.providerName}. If it fails, Feroxes falls back to your other enabled models.`] : 'No chat model yet. Set up a provider below and pick a model for chat.')),
        ),
        h('div', { class: 'provider-list' }, ...d.providers.map((p) =>
          h('button', { class: 'provider-row', on: { click: () => openId.set(p.id) } },
            h('span', { class: `integ-logo logo-p-${p.id}` }, MONO[p.id] ?? p.name[0]!),
            h('span', { class: 'col grow', style: 'min-width: 0; text-align: left' }, h('span', { style: 'font-weight: 560' }, p.name), h('span', { class: 'faint ellipsis', style: 'font-size: var(--text-sm)' }, p.models.filter((m) => m.enabled).map((m) => `${m.key} (${m.tier})`).join(', ') || (p.id === 'kiro' ? 'Uses the Kiro CLI on this PC' : 'No models chosen'))),
            h('span', { class: `pill ${STATUS[p.status][0]}` }, STATUS[p.status][1]),
            icon('chevron', 16),
          ))),
      );
    },
    () => {
      const d = data();
      const p = d?.providers.find((x) => x.id === openId());
      return p && d ? editor(p, d, () => openId.set(null), load) : false;
    },
  ]);
  return host;
}

function editor(p: P, d: Summary, close: () => void, reload: () => void): Node {
  const busy = signal(false);
  const found = signal<Found[] | null>(null);
  const filter = signal('');
  const models = signal<ModelCfg[]>(p.models.map((m) => ({ ...m })));
  const def = signal<string | undefined>(p.defaultModel);
  const testing = signal<Test | null>(p.lastTest ?? null);
  let keyInput = '';
  let manual = '';
  const run = async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    busy.set(true);
    try {
      const r = await fn();
      if (ok) toast({ title: ok, urgency: 'low' });
      return r;
    } catch (e) {
      toast({ title: p.name, body: (e as Error).message, urgency: 'high' });
      return undefined;
    } finally {
      busy.set(false);
      reload();
    }
  };
  const saveModels = () => run(() => api(`/providers/${p.id}`, { body: { models: models.peek(), defaultModel: def.peek() ?? null } }), 'Models saved');
  const addModel = (m: { key: string; contextWindow?: number; price?: { input: number; output: number } }) => {
    if (models.peek().some((x) => x.key === m.key)) return;
    models.set([...models.peek(), { key: m.key, tier: suggest(p.id, m.key), enabled: true, ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}), ...(m.price ? { price: { ...m.price, source: 'provider' as const } } : {}) }]);
    if (!def.peek()) def.set(m.key);
  };
  window.addEventListener('keydown', (e) => e.key === 'Escape' && close(), { once: true });

  const k = p.kiro;
  const kiroBlock = p.id === 'kiro' && k
    ? h('section', { class: 'col', style: 'gap: 10px' },
        h('h3', { class: 'section-title' }, 'Kiro CLI on this PC'),
        h('div', { class: `callout ${k.status?.installed ? (k.status.authenticated ? 'ok' : 'warn') : 'danger'}` },
          !k.status ? 'Checking…' : !k.status.installed ? k.status.error ?? 'Kiro CLI not found.' : [`${k.status.version ?? 'kiro-cli'} found. `, k.status.authenticated ? `Signed in${k.status.detail ? `: ${k.status.detail}` : ''}.` : `Not signed in${k.status.detail ? ` (${k.status.detail})` : ''}. Run "kiro-cli login" in a terminal, or use an API key below.`]),
        h('div', { class: 'row', style: 'gap: 8px' },
          h('button', { class: 'btn sm', disabled: () => busy(), on: { click: () => run(() => api('/providers/kiro/status'), 'Checked') } }, icon('refresh', 14), ' Check again')),
        h('label', { class: 'form-field' }, h('span', { class: 'form-label' }, 'Kiro CLI command or full path'), h('input', { class: 'input', value: k.command ?? 'kiro-cli', on: { change: (e: Event) => void run(() => api('/providers/kiro', { body: { kiro: { command: (e.target as HTMLInputElement).value } } }), 'Saved') } })),
        h('label', { class: 'toggle-row' }, h('input', { type: 'checkbox', checked: k.useLogin, on: { change: (e: Event) => void run(() => api('/providers/kiro', { body: { kiro: { useLogin: (e.target as HTMLInputElement).checked } } }), 'Saved') } }), h('span', { class: 'toggle' }), h('span', { class: 'col' }, h('span', {}, 'Use my existing "kiro-cli login"'), h('span', { class: 'faint', style: 'font-size: var(--text-sm)' }, 'Off = use the Kiro API key below (headless API keys are for Kiro Pro, Pro+, Pro Max and Power).'))),
        h('div', { class: 'callout warn' }, h('strong', {}, 'Kiro usage terms. '), d.kiroTermsNotice),
        k.acknowledgedTerms
          ? h('span', { class: 'faint', style: 'font-size: var(--text-sm)' }, `You accepted this ${timeAgo(k.acknowledgedTerms)}.`)
          : h('button', { class: 'btn sm', disabled: () => busy(), on: { click: () => run(() => api('/providers/kiro', { body: { acknowledgeKiroTerms: true } }), 'Accepted') } }, 'I understand and accept the risk'),
      )
    : false;

  const keyBlock = p.keyLabel && (p.keyRequired || (p.id === 'kiro' && !k?.useLogin))
    ? h('section', { class: 'col', style: 'gap: 8px' },
        h('h3', { class: 'section-title' }, p.keyLabel),
        p.hasKey
          ? h('div', { class: 'row', style: 'gap: 8px' }, h('code', { class: 'copyable grow', style: 'cursor: default' }, `Saved · ${p.keyHint ?? '••••'}`), h('button', { class: 'btn sm ghost danger', disabled: () => busy(), on: { click: () => confirm(`Remove the ${p.name} key from the vault?`) && void run(() => api(`/providers/${p.id}/key`, { method: 'DELETE' }), 'Key removed') } }, 'Remove'))
          : false,
        h('div', { class: 'row', style: 'gap: 8px' },
          h('input', { class: 'input grow', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: p.hasKey ? 'Paste a new key to replace it' : (p.keyPlaceholder ?? ''), on: { input: (e: Event) => (keyInput = (e.target as HTMLInputElement).value) } }),
          h('button', { class: 'btn primary sm', disabled: () => busy(), on: { click: () => keyInput.trim() && void run(() => api(`/providers/${p.id}/key`, { body: { key: keyInput } }), 'Key saved in the vault') } }, 'Save key'),
        ),
        p.keyUrl ? h('a', { class: 'faint', href: p.keyUrl, target: '_blank', rel: 'noopener', style: 'font-size: var(--text-sm)' }, `Get a key: ${p.keyUrl.replace(/^https:\/\//, '')}`) : false,
      )
    : false;

  const baseBlock = p.baseUrlEditable
    ? h('section', { class: 'col', style: 'gap: 8px' }, h('h3', { class: 'section-title' }, 'Address'), h('input', { class: 'input', value: p.baseUrl ?? '', on: { change: (e: Event) => void run(() => api(`/providers/${p.id}`, { body: { baseUrl: (e.target as HTMLInputElement).value } }), 'Saved') } }))
    : false;

  const modelRow = (m: ModelCfg, i: number) =>
    h('div', { class: 'model-row' },
      h('label', { class: 'row', style: 'gap: 8px; min-width: 0', title: 'Use for chat' }, h('input', { type: 'radio', name: `def-${p.id}`, checked: def() === m.key, on: { change: () => def.set(m.key) } }), h('span', { class: 'mono ellipsis' }, m.key)),
      h('select', { class: 'input select', 'aria-label': 'Tier', on: { change: (e: Event) => models.set(models.peek().map((x, j) => (j === i ? { ...x, tier: (e.target as HTMLSelectElement).value as Tier } : x))) } }, ...TIERS.map((t) => h('option', { value: t, selected: m.tier === t, title: TIER_HELP[t] }, t))),
      p.id === 'ollama' || p.id === 'kiro'
        ? h('span', { class: 'faint', style: 'font-size: var(--text-xs)' }, p.id === 'kiro' ? 'Kiro credits' : 'free')
        : h('span', { class: 'row price', title: 'USD per 1M tokens (input / output). Empty = cautious estimate for budgets.' },
            h('input', { class: 'input', inputmode: 'decimal', placeholder: String(d.cautiousPrice.input), value: m.price ? String(m.price.input) : '', on: { change: (e: Event) => setPrice(i, 'input', (e.target as HTMLInputElement).value) } }),
            h('input', { class: 'input', inputmode: 'decimal', placeholder: String(d.cautiousPrice.output), value: m.price ? String(m.price.output) : '', on: { change: (e: Event) => setPrice(i, 'output', (e.target as HTMLInputElement).value) } })),
      h('button', { class: 'btn icon-btn ghost sm', 'aria-label': `Remove ${m.key}`, on: { click: () => { models.set(models.peek().filter((_, j) => j !== i)); if (def.peek() === m.key) def.set(models.peek()[0]?.key); } } }, icon('x', 14)),
    );
  const setPrice = (i: number, which: 'input' | 'output', v: string) => {
    const n = Number(v.replace(',', '.'));
    models.set(models.peek().map((x, j) => {
      if (j !== i) return x;
      if (v.trim() === '' || !Number.isFinite(n) || n < 0) {
        const { price: _drop, ...rest } = x;
        return rest;
      }
      const base = x.price ?? { input: n, output: n, source: 'owner' as const };
      return { ...x, price: { ...base, [which]: n, source: 'owner' as const } };
    }));
  };

  const testView = () => {
    const t = testing();
    if (!t) return h('p', { class: 'faint', style: 'font-size: var(--text-sm)' }, 'Not tested yet. "Test connection" sends one tiny real request (it counts toward your spending limits).');
    return h('div', { class: `callout ${t.ok ? 'ok' : 'danger'} col`, style: 'gap: 4px' },
      h('strong', {}, t.ok ? 'Connected: a real reply came back.' : 'Not working'),
      h('span', {}, `Credentials: ${t.auth === 'ok' ? 'accepted' : t.auth === 'failed' ? 'rejected' : 'not checked'}${t.modelsAvailable !== undefined ? ` · ${t.modelsAvailable} models available` : ''}${t.model ? ` · model ${t.model}` : ''}`),
      t.ok ? h('span', {}, `Reply "${t.reply}" in ${t.latencyMs} ms · ${t.tokens?.input ?? 0}+${t.tokens?.output ?? 0} tokens · ${p.id === 'kiro' ? 'Kiro credits' : usd(t.costNanoUsd ?? 0)}`) : false,
      t.error ? h('span', {}, t.error) : false,
      h('span', { class: 'faint', style: 'font-size: var(--text-xs)' }, `Tested ${timeAgo(t.at)}`),
    );
  };

  return h('div', {},
    h('div', { class: 'scrim', on: { click: close } }),
    h('aside', { class: 'drawer', role: 'dialog', 'aria-label': `${p.name} settings` },
      h('div', { class: 'drawer-head row' },
        h('span', { class: `integ-logo logo-p-${p.id}` }, MONO[p.id] ?? p.name[0]!),
        h('div', { class: 'col grow' }, h('strong', { style: 'font-size: var(--text-md)' }, p.name), h('a', { class: 'faint', href: p.docsUrl, target: '_blank', rel: 'noopener', style: 'font-size: var(--text-sm)' }, 'Official docs')),
        h('label', { class: 'toggle-row', style: 'padding: 0', title: 'Enable' }, h('input', { type: 'checkbox', checked: p.enabled, on: { change: (e: Event) => void run(() => api(`/providers/${p.id}`, { body: { enabled: (e.target as HTMLInputElement).checked } }), (e.target as HTMLInputElement).checked ? `${p.name} enabled` : `${p.name} disabled`) } }), h('span', { class: 'toggle' })),
        h('button', { class: 'btn icon-btn ghost', 'aria-label': 'Close', on: { click: close } }, icon('x')),
      ),
      h('div', { class: 'drawer-body col', style: 'gap: var(--space-5)' },
        h('ul', { class: 'limits' }, ...p.notes.map((n) => h('li', {}, n))),
        kiroBlock,
        keyBlock,
        baseBlock,
        h('section', { class: 'col', style: 'gap: 10px' },
          h('div', { class: 'row', style: 'gap: 8px' }, h('h3', { class: 'section-title grow' }, 'Models'), h('button', { class: 'btn sm', disabled: () => busy(), on: { click: async () => { const r = await run(() => api<{ models: Found[] }>(`/providers/${p.id}/discover`, { body: {} })); if (r) found.set(r.models); } } }, icon('search', 14), ' Find models')),
          () => (models().length ? h('div', { class: 'col', style: 'gap: 6px' }, h('div', { class: 'model-row head faint' }, h('span', {}, 'Model (selected = chat)'), h('span', {}, 'Tier'), h('span', {}, p.id === 'ollama' || p.id === 'kiro' ? 'Cost' : '$ / 1M in · out'), h('span', {})), ...models().map(modelRow)) : h('p', { class: 'faint', style: 'font-size: var(--text-sm)' }, 'No models chosen yet. Use "Find models" or type a model id.')),
          () => {
            const f = found();
            if (!f) return false;
            const q = filter().toLowerCase();
            const shown = f.filter((m) => !q || m.key.toLowerCase().includes(q) || (m.label ?? '').toLowerCase().includes(q)).slice(0, 60);
            return h('div', { class: 'found col', style: 'gap: 6px' },
              h('input', { class: 'input', placeholder: `Filter ${f.length} models…`, on: { input: (e: Event) => filter.set((e.target as HTMLInputElement).value) } }),
              h('div', { class: 'found-list' }, ...shown.map((m) => h('button', { class: `found-item${m.chat ? '' : ' dim'}`, disabled: models.peek().some((x) => x.key === m.key), on: { click: () => addModel(m) } }, icon('plus', 13), h('span', { class: 'mono grow ellipsis' }, m.key), m.price ? h('span', { class: 'faint' }, `$${m.price.input}/$${m.price.output}`) : false, m.chat ? false : h('span', { class: 'faint' }, 'not chat')))),
            );
          },
          h('div', { class: 'row', style: 'gap: 8px' },
            h('input', { class: 'input grow', placeholder: 'Or type a model id exactly as the provider names it', on: { input: (e: Event) => (manual = (e.target as HTMLInputElement).value) } }),
            h('button', { class: 'btn sm', on: { click: () => manual.trim() && addModel({ key: manual.trim() }) } }, 'Add')),
          h('div', { class: 'row', style: 'gap: 8px' },
            h('button', { class: 'btn primary', disabled: () => busy(), on: { click: () => saveModels() } }, 'Save models'),
            h('button', { class: 'btn', disabled: () => busy() || !def(), on: { click: async () => { await saveModels(); await run(() => api('/providers/chat-default', { body: { providerId: p.id, modelKey: def.peek() } }), `Chat now uses ${def.peek()}`); } } }, 'Save and use for chat'),
          ),
        ),
        h('section', { class: 'col', style: 'gap: 10px' },
          h('div', { class: 'row', style: 'gap: 8px' }, h('h3', { class: 'section-title grow' }, 'Connection test'), h('button', { class: 'btn sm primary', disabled: () => busy(), on: { click: async () => { const r = await run(() => api<Test>(`/providers/${p.id}/test`, { body: def.peek() ? { model: def.peek() } : {} })); if (r) testing.set(r); } } }, () => (busy() ? 'Testing…' : 'Test connection'))),
          testView,
        ),
      ),
    ),
  );
}

function suggest(id: string, key: string): Tier {
  if (id === 'ollama') return 'local';
  if (id === 'kiro') return 'balanced';
  const k = key.toLowerCase();
  if (/(mini|nano|lite|haiku|small|tiny|-[1-9]b)/.test(k)) return 'fast';
  if (/(opus|ultra|large|-pro|405b|thinking)/.test(k)) return 'frontier';
  return 'balanced';
}
