import { spawn } from 'node:child_process';
import { type Capability, type Catalog, type HealthTracker, type ModelEntry, type ModelRouter, type ProviderAdapter, type ProviderEntry, type ProviderKind, createAdapter } from '@feroxes/llm';
import type { PriceBook } from '@feroxes/metering';
import { type Logger, type Tier, errorMessage, noopLogger, scrubSecrets } from '@feroxes/shared';
import { ROUTES } from './catalog.ts';
import type { Env } from './config.ts';
import type { SecretDocs, SecretStore } from './vault.ts';

/**
 * AI providers configured from Settings → Providers, on top of the existing router: credentials
 * are sealed in the vault, models come from each provider's documented model list (or are typed
 * by the owner), and the result is applied to the live catalog, adapters and price book, so a
 * change works immediately without a restart. Nothing here invents model ids or prices:
 * - OpenRouter publishes per-token prices in its model list; Ollama and Kiro cost $0 per token
 *   (Kiro bills subscription credits, tracked by Kiro);
 * - for OpenAI, Anthropic and Gemini the owner enters prices; until then budgets use a cautious
 *   high estimate (CAUTIOUS_PRICE), so spending limits trigger early rather than late.
 */
export type ProviderId = 'openai' | 'anthropic' | 'google' | 'openrouter' | 'ollama' | 'kiro';
export const PROVIDER_IDS: ProviderId[] = ['openai', 'anthropic', 'google', 'openrouter', 'ollama', 'kiro'];
export const CAUTIOUS_PRICE = { input: 15, output: 75 } as const; // USD per 1M tokens, deliberately high

export interface ModelConfig {
  key: string;
  tier: Tier;
  enabled: boolean;
  label?: string;
  contextWindow?: number;
  /** USD per 1M tokens. */
  price?: { input: number; output: number; source: 'provider' | 'owner' };
}

export interface TestResult {
  at: number;
  ok: boolean;
  auth: 'ok' | 'failed' | 'unknown';
  modelsAvailable?: number;
  model?: string;
  latencyMs?: number;
  reply?: string;
  tokens?: { input: number; output: number };
  costNanoUsd?: number;
  error?: string;
}

export interface ProviderConfig {
  id: ProviderId;
  enabled: boolean;
  models: ModelConfig[];
  defaultModel?: string;
  baseUrl?: string;
  keyHint?: string;
  kiro?: { command?: string; agent?: string; useLogin: boolean; acknowledgedTerms?: number };
  lastTest?: TestResult;
  updatedAt: number;
}

interface Def {
  id: ProviderId;
  name: string;
  kind: ProviderKind;
  keyLabel?: string;
  keyRequired: boolean;
  keyPlaceholder?: string;
  keyUrl?: string;
  baseUrl?: string;
  baseUrlEditable: boolean;
  docsUrl: string;
  caps: Capability[];
  defaultTier: Tier;
  defaultContext: number;
  notes: string[];
}

const CHAT_CAPS: Capability[] = ['tools', 'streaming', 'json_schema', 'vision', 'prompt_cache'];

export const PROVIDER_DEFS: Record<ProviderId, Def> = {
  openai: { id: 'openai', name: 'OpenAI', kind: 'openai', keyLabel: 'API key', keyRequired: true, keyPlaceholder: 'sk-…', keyUrl: 'https://platform.openai.com/api-keys', baseUrl: 'https://api.openai.com/v1', baseUrlEditable: false, docsUrl: 'https://platform.openai.com/docs/api-reference/models/list', caps: CHAT_CAPS, defaultTier: 'balanced', defaultContext: 128_000, notes: ['Model list from GET /v1/models. It includes non-chat models (embeddings, speech, images); choose chat models.', 'Enter prices from openai.com/api/pricing; until then budgets use a cautious estimate.'] },
  anthropic: { id: 'anthropic', name: 'Anthropic Claude', kind: 'anthropic', keyLabel: 'API key', keyRequired: true, keyPlaceholder: 'sk-ant-…', keyUrl: 'https://console.anthropic.com/settings/keys', baseUrl: 'https://api.anthropic.com', baseUrlEditable: false, docsUrl: 'https://docs.anthropic.com/en/api/models-list', caps: CHAT_CAPS, defaultTier: 'balanced', defaultContext: 200_000, notes: ['Model list from GET /v1/models.', 'Enter prices from anthropic.com/pricing; until then budgets use a cautious estimate.'] },
  google: { id: 'google', name: 'Google Gemini', kind: 'google', keyLabel: 'API key', keyRequired: true, keyPlaceholder: 'AIza…', keyUrl: 'https://aistudio.google.com/apikey', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', baseUrlEditable: false, docsUrl: 'https://ai.google.dev/api/models', caps: CHAT_CAPS, defaultTier: 'balanced', defaultContext: 1_000_000, notes: ['Model list from GET /v1beta/models (only models that support generateContent are shown).', 'On the free tier Google may use your prompts to improve its products; Feroxes sends it at most "normal" data.'] },
  openrouter: { id: 'openrouter', name: 'OpenRouter', kind: 'openai-compatible', keyLabel: 'API key', keyRequired: true, keyPlaceholder: 'sk-or-v1-…', keyUrl: 'https://openrouter.ai/settings/keys', baseUrl: 'https://openrouter.ai/api/v1', baseUrlEditable: false, docsUrl: 'https://openrouter.ai/docs/api-reference/list-available-models', caps: CHAT_CAPS, defaultTier: 'balanced', defaultContext: 128_000, notes: ['Model list and per-token prices from GET /api/v1/models.'] },
  ollama: { id: 'ollama', name: 'Ollama (local)', kind: 'openai-compatible', keyRequired: false, baseUrl: 'http://localhost:11434', baseUrlEditable: true, docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/api.md', caps: ['tools', 'streaming', 'json_schema'], defaultTier: 'local', defaultContext: 32_000, notes: ['Runs on your PC: free, private, may be slow on large models. Models come from GET /api/tags.', 'Ollama truncates prompts beyond its context size (num_ctx); raise it in Ollama for long chats.'] },
  kiro: { id: 'kiro', name: 'Kiro (CLI)', kind: 'kiro', keyLabel: 'Kiro API key (headless, optional)', keyRequired: false, keyPlaceholder: 'from app.kiro.dev → Settings → API keys', keyUrl: 'https://app.kiro.dev', baseUrlEditable: false, docsUrl: 'https://kiro.dev/docs/cli/headless/', caps: ['tools', 'streaming', 'json_schema', 'reasoning'], defaultTier: 'balanced', defaultContext: 200_000, notes: ['Kiro has no public HTTP model API. Feroxes runs the official Kiro CLI in headless mode (`kiro-cli chat --no-interactive`, prompt on stdin) with your existing `kiro-cli login`, or with KIRO_API_KEY (Kiro documents API keys for headless use on paid plans).', 'Kiro only reasons: Feroxes never passes --trust-tools or --trust-all-tools, so Kiro\'s own tools stay off and every action still goes through Feroxes\'s policy gate.', 'Replies arrive in one piece (no streaming). Usage is billed as Kiro credits, shown in Kiro, not in Feroxes\'s dollar ledger.'] },
};

export const KIRO_TERMS_NOTICE = "Kiro documents headless mode for CI/CD pipelines and automation scripts. Kiro's billing terms restrict using a Kiro subscription through third-party harnesses that route requests outside Kiro's own interfaces. Using Kiro as Feroxes's reasoning engine may fall under that and could put your Kiro account at risk. Feroxes uses only the official CLI, never enables Kiro's tools, and keeps your other providers as fallback. Turn Kiro on only if you accept that risk.";

const KIND = 'provider';
const SETTINGS = { kind: 'provider_settings', id: 'chat' };
const mask = (k: string) => (k.length >= 12 ? `${k.slice(0, Math.min(7, k.length - 8))}…${k.slice(-4)}` : '••••');
const now = () => Date.now();

/** Name-based tier suggestion for a newly chosen model; the owner can change it. */
export function suggestTier(id: ProviderId, key: string): Tier {
  if (id === 'ollama') return 'local';
  if (id === 'kiro') return 'balanced';
  const k = key.toLowerCase();
  if (/(mini|nano|lite|haiku|small|tiny|\b[1-9]b\b|-[1-9]b)/.test(k)) return 'fast';
  if (/(opus|ultra|large|\bpro\b|-pro|405b|thinking|deep-research)/.test(k)) return 'frontier';
  return 'balanced';
}

export interface DiscoveredModel {
  key: string;
  label?: string;
  contextWindow?: number;
  price?: { input: number; output: number };
  chat: boolean;
}

export interface ProvidersOptions {
  docs: SecretDocs;
  secrets: SecretStore;
  catalog: Catalog;
  adapters: Map<string, ProviderAdapter>;
  prices: PriceBook;
  router: ModelRouter;
  health: HealthTracker;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Runs a command for Kiro detection (tests inject a stub). */
  exec?: (cmd: string, args: string[], env: Record<string, string>, timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string; error?: string }>;
}

export class Providers {
  private readonly o: Required<Omit<ProvidersOptions, 'exec'>> & Pick<ProvidersOptions, 'exec'>;
  private kiroCache?: { at: number; value: KiroStatus };
  private readonly listeners = new Set<() => void>();

  constructor(options: ProvidersOptions) {
    this.o = { fetch: globalThis.fetch.bind(globalThis), logger: noopLogger, ...options };
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  config(id: ProviderId): ProviderConfig {
    if (!PROVIDER_IDS.includes(id)) throw Object.assign(new Error(`Unknown provider "${id}".`), { code: 'not_found' });
    return this.o.docs.get<ProviderConfig>(KIND, id) ?? { id, enabled: false, models: [], ...(PROVIDER_DEFS[id].baseUrl && PROVIDER_DEFS[id].baseUrlEditable ? { baseUrl: PROVIDER_DEFS[id].baseUrl } : {}), ...(id === 'kiro' ? { kiro: { useLogin: true } } : {}), updatedAt: 0 };
  }

  private save(c: ProviderConfig) {
    this.o.docs.put(KIND, { ...c, updatedAt: now() });
  }

  private key(id: ProviderId): string | undefined {
    return this.o.secrets.get(`provider:${id}:api_key`);
  }

  chatDefault(): { providerId: ProviderId; modelKey: string } | undefined {
    const d = this.o.docs.get<{ id: string; providerId?: ProviderId; modelKey?: string }>(SETTINGS.kind, SETTINGS.id);
    return d?.providerId && d.modelKey ? { providerId: d.providerId, modelKey: d.modelKey } : undefined;
  }

  /** First start: keys from the environment (.env) move into the vault, as if entered in Settings. */
  importFromEnv(env: Env): void {
    const fromEnv: [ProviderId, string | undefined][] = [['openai', env.OPENAI_API_KEY], ['anthropic', env.ANTHROPIC_API_KEY], ['google', env.GEMINI_API_KEY], ['openrouter', env.OPENROUTER_API_KEY]];
    for (const [id, key] of fromEnv) {
      if (!key || this.key(id) || this.o.docs.get(KIND, id)) continue;
      this.o.secrets.put(`provider:${id}:api_key`, key);
      this.save({ ...this.config(id), enabled: true, keyHint: mask(key) });
    }
    if (env.OLLAMA_BASE_URL && !this.o.docs.get(KIND, 'ollama')) this.save({ ...this.config('ollama'), enabled: true, baseUrl: env.OLLAMA_BASE_URL.replace(/\/v1\/?$/, ''), models: [{ key: env.OLLAMA_MODEL, tier: 'local', enabled: true }] });
    if (env.FEROXES_KIRO_BRAIN && (env.KIRO_API_KEY || env.FEROXES_KIRO_USE_LOGIN) && !this.o.docs.get(KIND, 'kiro')) {
      if (env.KIRO_API_KEY) this.o.secrets.put('provider:kiro:api_key', env.KIRO_API_KEY);
      // Setting FEROXES_KIRO_* by hand was the owner's explicit, informed choice (docs/07).
      this.save({ ...this.config('kiro'), enabled: true, ...(env.KIRO_API_KEY ? { keyHint: mask(env.KIRO_API_KEY) } : {}), kiro: { command: env.KIRO_CLI_COMMAND, ...(env.KIRO_CLI_AGENT ? { agent: env.KIRO_CLI_AGENT } : {}), useLogin: env.FEROXES_KIRO_USE_LOGIN, acknowledgedTerms: now() }, models: [{ key: env.KIRO_BALANCED_MODEL || 'default', tier: 'balanced', enabled: true }, ...(env.KIRO_FRONTIER_MODEL ? [{ key: env.KIRO_FRONTIER_MODEL, tier: 'frontier' as Tier, enabled: true }] : [])] });
    }
  }

  setKey(id: ProviderId, key: string): void {
    const k = key.trim();
    if (k.length < 8 || /\s/.test(k)) throw Object.assign(new Error('That doesn\'t look like an API key.'), { code: 'bad_request' });
    this.o.secrets.put(`provider:${id}:api_key`, k);
    this.save({ ...this.config(id), keyHint: mask(k), lastTest: undefined } as ProviderConfig);
    this.kiroCache = undefined;
    this.apply();
  }

  removeKey(id: ProviderId): void {
    this.o.secrets.delete(`provider:${id}:api_key`);
    const c = this.config(id);
    delete c.keyHint;
    delete c.lastTest;
    this.save(c);
    this.kiroCache = undefined;
    this.apply();
  }

  update(id: ProviderId, patch: { enabled?: boolean; models?: ModelConfig[]; defaultModel?: string | null; baseUrl?: string; kiro?: Partial<NonNullable<ProviderConfig['kiro']>>; acknowledgeKiroTerms?: boolean }): ProviderConfig {
    const c = this.config(id);
    if (patch.baseUrl !== undefined) {
      if (!PROVIDER_DEFS[id].baseUrlEditable) throw Object.assign(new Error('This provider has a fixed address.'), { code: 'bad_request' });
      const u = new URL(patch.baseUrl);
      if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('Use an http(s) address.'), { code: 'bad_request' });
      c.baseUrl = u.toString().replace(/\/+$/, '').replace(/\/v1$/, '');
    }
    if (patch.models) {
      const seen = new Set<string>();
      c.models = patch.models
        .filter((m) => typeof m.key === 'string' && m.key.trim() && !seen.has(m.key.trim()) && seen.add(m.key.trim()))
        .slice(0, 50)
        .map((m) => ({
          key: m.key.trim().slice(0, 200),
          tier: (['fast', 'balanced', 'frontier', 'local'] as Tier[]).includes(m.tier) ? m.tier : suggestTier(id, m.key),
          enabled: m.enabled !== false,
          ...(m.label ? { label: String(m.label).slice(0, 100) } : {}),
          ...(m.contextWindow && m.contextWindow > 1000 ? { contextWindow: Math.min(10_000_000, Math.round(m.contextWindow)) } : {}),
          ...(m.price && Number.isFinite(m.price.input) && Number.isFinite(m.price.output) && m.price.input >= 0 && m.price.output >= 0 ? { price: { input: m.price.input, output: m.price.output, source: m.price.source === 'provider' ? ('provider' as const) : ('owner' as const) } } : {}),
        }));
    }
    if (patch.defaultModel !== undefined) {
      if (patch.defaultModel === null) delete c.defaultModel;
      else c.defaultModel = patch.defaultModel;
    }
    if (patch.kiro && id === 'kiro') c.kiro = { ...(c.kiro ?? { useLogin: true }), ...(patch.kiro.command !== undefined ? { command: patch.kiro.command.trim() || 'kiro-cli' } : {}), ...(patch.kiro.agent !== undefined ? { agent: patch.kiro.agent.trim() } : {}), ...(patch.kiro.useLogin !== undefined ? { useLogin: !!patch.kiro.useLogin } : {}) };
    if (patch.acknowledgeKiroTerms && id === 'kiro') c.kiro = { ...(c.kiro ?? { useLogin: true }), acknowledgedTerms: now() };
    if (patch.enabled !== undefined) {
      if (patch.enabled && id === 'kiro' && !c.kiro?.acknowledgedTerms) throw Object.assign(new Error('Read and accept the Kiro usage notice first.'), { code: 'bad_request' });
      if (patch.enabled && PROVIDER_DEFS[id].keyRequired && !this.key(id)) throw Object.assign(new Error('Save an API key first.'), { code: 'bad_request' });
      c.enabled = patch.enabled;
    }
    this.save(c);
    if (patch.kiro) this.kiroCache = undefined;
    this.apply();
    return this.config(id);
  }

  setChatDefault(providerId: ProviderId, modelKey: string): void {
    const c = this.config(providerId);
    if (!c.models.some((m) => m.key === modelKey && m.enabled)) throw Object.assign(new Error('Enable that model first.'), { code: 'bad_request' });
    this.o.docs.put(SETTINGS.kind, { id: SETTINGS.id, providerId, modelKey });
    this.apply();
  }

  /** Builds the provider entry and adapter for a config (null when it can't run). */
  private entry(c: ProviderConfig, suffix = ''): { entry: ProviderEntry; adapter: ProviderAdapter } | null {
    const d = PROVIDER_DEFS[c.id];
    const key = this.key(c.id);
    if (d.keyRequired && !key) return null;
    const base = c.id === 'ollama' ? `${(c.baseUrl ?? d.baseUrl)!.replace(/\/+$/, '')}/v1` : d.baseUrl;
    const kiroSettings = c.id === 'kiro' ? { command: c.kiro?.command || 'kiro-cli', ...(c.kiro?.agent ? { extraArgs: ['--agent', c.kiro.agent] } : {}) } : undefined;
    const entry: ProviderEntry = {
      id: c.id + suffix,
      kind: d.kind,
      name: d.name,
      ...(base ? { baseUrl: base } : {}),
      ...(c.id === 'openrouter' ? { headers: { 'X-Title': 'Feroxes' } } : {}),
      enabled: true,
      maxSensitivity: c.id === 'ollama' ? 'secret' : c.id === 'google' ? 'normal' : 'private',
      ...(kiroSettings ? { settings: kiroSettings } : {}),
      ...(c.id === 'kiro' ? { timeouts: { firstTokenMs: 120_000, totalMs: 600_000 } } : c.id === 'ollama' ? { timeouts: { firstTokenMs: 120_000, totalMs: 600_000 } } : {}),
    };
    // Kiro: the API key only if the owner chose it over the CLI login.
    const adapterKey = c.id === 'kiro' ? (c.kiro?.useLogin ? undefined : key) : key;
    try {
      return { entry, adapter: createAdapter(entry, adapterKey, this.o.fetch as never) };
    } catch {
      return null;
    }
  }

  private model(c: ProviderConfig, m: ModelConfig, suffix = ''): ModelEntry {
    const d = PROVIDER_DEFS[c.id];
    return { id: `${c.id}${suffix}/${m.key}`, providerId: c.id + suffix, modelKey: m.key, displayName: m.label ?? m.key, modality: 'chat', capabilities: d.caps, contextWindow: m.contextWindow ?? d.defaultContext, maxOutputTokens: 8192, tier: m.tier, enabled: true };
  }

  private price(c: ProviderConfig, m: ModelConfig, modelId: string) {
    const free = c.id === 'ollama' || c.id === 'kiro';
    const p = free ? { input: 0, output: 0 } : (m.price ?? CAUTIOUS_PRICE);
    this.o.prices.add({ id: `cfg-${modelId}-${now()}`, modelId, effectiveFrom: 0, inputPerMTok: p.input, outputPerMTok: p.output });
  }

  /** Applies every provider config to the live router (no restart needed). */
  apply(): void {
    const tiers: Record<Tier, string[]> = { fast: [], balanced: [], frontier: [], local: [] };
    const def = this.chatDefault();
    for (const id of PROVIDER_IDS) {
      const c = this.config(id);
      const built = c.enabled ? this.entry(c) : null;
      const prev = this.o.catalog.provider(id);
      if (!built) {
        if (prev) this.o.catalog.upsertProvider({ ...prev, enabled: false });
        this.o.adapters.delete(id);
        for (const m of this.o.catalog.listModels().filter((x) => x.providerId === id)) this.o.catalog.upsertModel({ ...m, enabled: false });
        continue;
      }
      this.o.catalog.upsertProvider(built.entry);
      this.o.adapters.set(id, built.adapter);
      this.o.health.resetProvider(id);
      for (const m of this.o.catalog.listModels().filter((x) => x.providerId === id)) this.o.catalog.upsertModel({ ...m, enabled: false });
      const enabled = c.models.filter((m) => m.enabled);
      const ordered = [...enabled].sort((a, b) => Number(b.key === c.defaultModel) - Number(a.key === c.defaultModel));
      for (const m of ordered) {
        const me = this.model(c, m);
        this.o.catalog.upsertModel(me);
        this.price(c, m, me.id);
        tiers[m.tier].push(me.id);
      }
    }
    // The chat default goes first in its tier, and chat uses that tier.
    let chatTier: Tier | 'auto' = 'auto';
    if (def) {
      const id = `${def.providerId}/${def.modelKey}`;
      for (const t of Object.keys(tiers) as Tier[]) {
        const i = tiers[t].indexOf(id);
        if (i >= 0) {
          tiers[t].splice(i, 1);
          tiers[t].unshift(id);
          chatTier = t;
        }
      }
    }
    for (const t of Object.keys(tiers) as Tier[]) this.o.catalog.setTier(t, tiers[t]);
    const chat = ROUTES.find((r) => r.id === 'chat.turn')!;
    this.o.catalog.upsertRoute({ ...chat, tier: chatTier });
    this.emit();
  }

  /** The documented model list of a provider (a real request). */
  async discover(id: ProviderId): Promise<{ models: DiscoveredModel[]; latencyMs: number }> {
    const c = this.config(id);
    const key = this.key(id);
    const d = PROVIDER_DEFS[id];
    if (id === 'kiro') return { models: [{ key: 'default', label: 'Kiro default (Kiro chooses the model)', chat: true }], latencyMs: 0 };
    if (d.keyRequired && !key) throw Object.assign(new Error('Save an API key first.'), { code: 'bad_request' });
    const t0 = now();
    const get = async (url: string, headers: Record<string, string>) => {
      let res: Response;
      try {
        res = await this.o.fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(20_000) });
      } catch (e) {
        throw new Error(`Couldn't reach ${new URL(url).host}: ${errorMessage(e)}${id === 'ollama' ? ' — is Ollama running?' : ''}`);
      }
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`${d.name} rejected the API key (${res.status}). Check or replace it.`), { auth: true });
      if (!res.ok) throw new Error(`${d.name} answered ${res.status}: ${scrubSecrets(JSON.stringify(body.error ?? body).slice(0, 200), key ? [key] : [])}`);
      return body;
    };
    let models: DiscoveredModel[] = [];
    if (id === 'openai') {
      const b = await get('https://api.openai.com/v1/models', { authorization: `Bearer ${key}` });
      models = ((b.data as { id: string }[]) ?? []).map((m) => ({ key: m.id, chat: !/(embedding|whisper|tts|dall-e|davinci|babbage|moderation|transcribe|image|audio|realtime|search|computer-use|sora)/.test(m.id) }));
    } else if (id === 'anthropic') {
      const b = await get('https://api.anthropic.com/v1/models?limit=100', { 'x-api-key': key!, 'anthropic-version': '2023-06-01' });
      models = ((b.data as { id: string; display_name?: string }[]) ?? []).map((m) => ({ key: m.id, ...(m.display_name ? { label: m.display_name } : {}), chat: true }));
    } else if (id === 'google') {
      const b = await get('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { 'x-goog-api-key': key! });
      models = ((b.models as { name: string; displayName?: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }[]) ?? [])
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => ({ key: m.name.replace(/^models\//, ''), ...(m.displayName ? { label: m.displayName } : {}), ...(m.inputTokenLimit ? { contextWindow: m.inputTokenLimit } : {}), chat: true }));
    } else if (id === 'openrouter') {
      const b = await get('https://openrouter.ai/api/v1/models', { authorization: `Bearer ${key}` });
      models = ((b.data as { id: string; name?: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }[]) ?? []).map((m) => {
        const pi = Number(m.pricing?.prompt);
        const po = Number(m.pricing?.completion);
        return { key: m.id, ...(m.name ? { label: m.name } : {}), ...(m.context_length ? { contextWindow: m.context_length } : {}), ...(Number.isFinite(pi) && Number.isFinite(po) && pi >= 0 && po >= 0 ? { price: { input: +(pi * 1e6).toFixed(4), output: +(po * 1e6).toFixed(4) } } : {}), chat: true };
      });
    } else if (id === 'ollama') {
      const b = await get(`${(c.baseUrl ?? d.baseUrl)!.replace(/\/+$/, '')}/api/tags`, {});
      models = ((b.models as { name: string }[]) ?? []).map((m) => ({ key: m.name, chat: !/embed/.test(m.name) }));
    }
    models.sort((a, b) => Number(b.chat) - Number(a.chat) || a.key.localeCompare(b.key));
    return { models, latencyMs: now() - t0 };
  }

  /**
   * A real connection test: the documented model list (auth + availability), then one minimal
   * chat request through the real router and adapter for the chosen model. It is metered like any
   * other call and respects the spending limits. The result is saved for the Settings screen.
   */
  async test(id: ProviderId, modelKey?: string): Promise<TestResult> {
    const c = this.config(id);
    const r: TestResult = { at: now(), ok: false, auth: 'unknown' };
    const finish = (patch: Partial<TestResult>) => {
      Object.assign(r, patch);
      this.save({ ...this.config(id), lastTest: r });
      this.emit();
      return r;
    };
    if (id === 'kiro') {
      // The CLI must exist; whether it is signed in is decided by a real headless request below
      // (`whoami` output differs between login and API-key use, so it is only shown as detail).
      const k = await this.kiroStatus(true);
      if (!k.installed) return finish({ auth: 'unknown', error: k.error ?? 'Kiro CLI is not installed or not on PATH.' });
    } else {
      try {
        const disc = await this.discover(id);
        r.auth = 'ok';
        r.modelsAvailable = disc.models.length;
        const want = modelKey ?? c.defaultModel ?? c.models.find((m) => m.enabled)?.key;
        if (want && disc.models.length && !disc.models.some((m) => m.key === want)) return finish({ model: want, error: `The model "${want}" is not in ${PROVIDER_DEFS[id].name}'s model list for this key. Pick one from "Find models".` });
      } catch (e) {
        return finish({ auth: (e as { auth?: boolean }).auth ? 'failed' : 'unknown', error: errorMessage(e) });
      }
    }
    const m = c.models.find((x) => x.key === (modelKey ?? c.defaultModel)) ?? c.models.find((x) => x.enabled) ?? (id === 'kiro' ? { key: 'default', tier: 'balanced' as Tier, enabled: true } : undefined);
    if (!m) return finish({ error: 'Credentials work. Now choose a model (Find models) and test again.' });
    const built = this.entry(c, '~test');
    if (!built) return finish({ error: 'This provider is missing its credentials.' });
    const me = this.model(c, m, '~test');
    this.o.catalog.upsertProvider(built.entry);
    this.o.adapters.set(built.entry.id, built.adapter);
    this.o.catalog.upsertModel(me);
    this.price(c, m, me.id);
    this.o.catalog.upsertRoute({ id: `provider.test.${id}`, tier: m.tier, requiredCapabilities: [], defaultPriority: 'interactive', allowEscalation: false, candidates: [me.id], maxOutputTokens: 16 });
    const t0 = now();
    try {
      const res = await this.o.router.generate({ route: `provider.test.${id}`, messages: [{ role: 'user', content: 'Reply with exactly the word OK.' }], maxOutputTokens: 16, sensitivity: 'normal', priority: 'interactive', attribution: { taskType: 'provider.test' } });
      return finish({ ok: res.text.trim().length > 0, auth: 'ok', model: m.key, latencyMs: now() - t0, reply: res.text.trim().slice(0, 200), tokens: { input: res.finish.usage.inputTokens, output: res.finish.usage.outputTokens }, costNanoUsd: res.finish.costNanoUsd, ...(res.text.trim() ? {} : { error: 'The provider answered with an empty reply.' }) });
    } catch (e) {
      const error = explainFailure(e, this.key(id));
      return finish({ model: m.key, latencyMs: now() - t0, error, ...(/rejected the credentials/.test(error) ? { auth: 'failed' as const } : {}) });
    } finally {
      this.o.catalog.upsertProvider({ ...built.entry, enabled: false });
      this.o.adapters.delete(built.entry.id);
    }
  }

  /** Kiro CLI: installed? version? signed in (`kiro-cli whoami`) or using an API key? */
  async kiroStatus(fresh = false): Promise<KiroStatus> {
    if (!fresh && this.kiroCache && now() - this.kiroCache.at < 30_000) return this.kiroCache.value;
    const c = this.config('kiro');
    const cmd = c.kiro?.command || 'kiro-cli';
    const key = this.key('kiro');
    const env: Record<string, string> = { NO_COLOR: '1', ...(key && !c.kiro?.useLogin ? { KIRO_API_KEY: key } : {}) };
    const exec = this.o.exec ?? runCommand;
    const v = await exec(cmd, ['--version'], env, 15_000);
    let value: KiroStatus;
    if (v.error || v.code !== 0) value = { installed: false, command: cmd, authenticated: false, error: v.error?.includes('ENOENT') || !v.error ? `Kiro CLI was not found ("${cmd}"). Install it from kiro.dev/cli, or set its full path.` : v.error };
    else {
      const w = await exec(cmd, ['whoami'], env, 20_000);
      const out = `${w.stdout}\n${w.stderr}`.trim();
      const authed = w.code === 0 && !/not logged in|not authenticated|login required|please log ?in/i.test(out);
      value = { installed: true, command: cmd, version: v.stdout.trim().split('\n')[0]!.slice(0, 80), authenticated: authed, method: key && !c.kiro?.useLogin ? 'api_key' : 'login', detail: scrubSecrets(out.split('\n').filter(Boolean).slice(0, 2).join(' · ').slice(0, 200), key ? [key] : []) };
    }
    this.kiroCache = { at: now(), value };
    return value;
  }

  async summaries() {
    const def = this.chatDefault();
    const kiro = await this.kiroStatus().catch(() => undefined);
    return {
      chatModel: def ? { ...def, providerName: PROVIDER_DEFS[def.providerId].name } : null,
      routedTiers: Object.fromEntries((['fast', 'balanced', 'frontier', 'local'] as Tier[]).map((t) => [t, this.o.catalog.tier(t)])),
      cautiousPrice: CAUTIOUS_PRICE,
      kiroTermsNotice: KIRO_TERMS_NOTICE,
      providers: PROVIDER_IDS.map((id) => {
        const c = this.config(id);
        const d = PROVIDER_DEFS[id];
        const hasKey = !!this.key(id);
        const ready = c.enabled && (!d.keyRequired || hasKey) && c.models.some((m) => m.enabled);
        return {
          id,
          name: d.name,
          keyLabel: d.keyLabel,
          keyRequired: d.keyRequired,
          keyPlaceholder: d.keyPlaceholder,
          keyUrl: d.keyUrl,
          baseUrlEditable: d.baseUrlEditable,
          docsUrl: d.docsUrl,
          notes: d.notes,
          enabled: c.enabled,
          hasKey,
          keyHint: c.keyHint,
          baseUrl: c.baseUrl ?? d.baseUrl,
          models: c.models,
          defaultModel: c.defaultModel,
          kiro: id === 'kiro' ? { ...(c.kiro ?? { useLogin: true }), status: kiro } : undefined,
          lastTest: c.lastTest,
          status: !c.enabled ? 'off' : !ready ? 'incomplete' : c.lastTest && !c.lastTest.ok ? 'error' : c.lastTest?.ok ? 'connected' : 'untested',
        };
      }),
    };
  }
}

export interface KiroStatus {
  installed: boolean;
  command: string;
  version?: string;
  authenticated: boolean;
  method?: 'login' | 'api_key';
  detail?: string;
  error?: string;
}

/** Turns router/adapter errors into something the owner can act on. */
export function explainFailure(e: unknown, key?: string): string {
  const err = e as { message?: string; attempts?: { errorClass?: string; reason?: string }[] };
  const first = err.attempts?.find((a) => a.errorClass) ?? undefined;
  const cls = first?.errorClass ?? '';
  const raw = scrubSecrets(`${first?.reason ?? ''} ${errorMessage(e)}`, key ? [key] : []);
  if (cls === 'auth_error' || /401|403|unauthori[sz]ed|invalid.*key|authentication/i.test(raw)) return `The provider rejected the credentials. Check or replace the key (or sign in again for Kiro). (${raw.slice(0, 160)})`;
  if (cls === 'model_not_found' || /model.*(not found|does not exist|not supported)|404/i.test(raw)) return `That model id isn't available to this account. Choose one from "Find models". (${raw.slice(0, 160)})`;
  if (cls === 'quota_exhausted' || /quota|credits|insufficient|billing/i.test(raw)) return `The account is out of quota or credits. (${raw.slice(0, 160)})`;
  if (cls === 'rate_limited' || /429|rate.?limit/i.test(raw)) return `Rate limited by the provider; wait a minute and try again. (${raw.slice(0, 160)})`;
  if (cls === 'timeout' || /timed? ?out/i.test(raw)) return `No answer in time. (${raw.slice(0, 160)})`;
  if (/budget|approval is needed/i.test(raw)) return `Stopped by your spending limit: ${raw.slice(0, 200)}`;
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|network|couldn't reach/i.test(raw)) return `Couldn't reach the provider (network). (${raw.slice(0, 160)})`;
  return raw.trim().slice(0, 300);
}

function runCommand(cmd: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let out = '';
    let errText = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: null, stdout: '', stderr: '', error: errorMessage(e) });
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout!.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr!.on('data', (d: Buffer) => (errText += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout: out, stderr: errText, error: errorMessage(e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out.replace(/\x1b\[[0-9;]*m/g, ''), stderr: errText.replace(/\x1b\[[0-9;]*m/g, '') });
    });
  });
}
