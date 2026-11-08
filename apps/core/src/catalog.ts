import type { Capability, ModelEntry, ProviderEntry, RouteConfig } from '@feroxes/llm';
import type { ModelPrice } from '@feroxes/metering';
import type { Tier } from '@feroxes/shared';
import type { Env } from './config.ts';

/**
 * Seed catalog for the owner's providers (Anthropic, OpenAI, Gemini, OpenRouter, optional Ollama).
 *
 * IMPORTANT: model ids and prices below come from third-party summaries dated October 2026
 * (see docs/02-tech-stack.md §3.1). Check them against each provider's model list and pricing
 * page before relying on cost numbers. Every entry can be overridden with config/models.json.
 */
const CHAT: Capability[] = ['tools', 'streaming', 'json_schema', 'vision', 'prompt_cache'];

interface Seed {
  id: string;
  providerId: string;
  modelKey: string;
  tier: Tier;
  contextWindow: number;
  maxOutputTokens: number;
  price: [input: number, output: number, cachedInput?: number];
  capabilities?: Capability[];
  modality?: 'chat' | 'embedding';
  dimensions?: number;
}

const SEEDS: Seed[] = [
  // Anthropic: cache reads at about 10 % of the input price.
  { id: 'anthropic/claude-opus-5.5', providerId: 'anthropic', modelKey: 'claude-opus-5-5', tier: 'frontier', contextWindow: 200_000, maxOutputTokens: 32_000, price: [4, 20, 0.4] },
  { id: 'anthropic/claude-sonnet-5.5', providerId: 'anthropic', modelKey: 'claude-sonnet-5-5', tier: 'balanced', contextWindow: 200_000, maxOutputTokens: 32_000, price: [2, 10, 0.2] },
  { id: 'anthropic/claude-haiku-5.5', providerId: 'anthropic', modelKey: 'claude-haiku-5-5', tier: 'fast', contextWindow: 200_000, maxOutputTokens: 16_000, price: [0.1, 0.5, 0.01] },
  // OpenAI
  { id: 'openai/gpt-6-astra', providerId: 'openai', modelKey: 'gpt-6-astra', tier: 'frontier', contextWindow: 272_000, maxOutputTokens: 32_000, price: [10, 50, 1] },
  { id: 'openai/gpt-6.1-sol', providerId: 'openai', modelKey: 'gpt-6.1-sol', tier: 'balanced', contextWindow: 272_000, maxOutputTokens: 32_000, price: [2, 10, 0.1] },
  { id: 'openai/gpt-6-luna', providerId: 'openai', modelKey: 'gpt-6-luna', tier: 'fast', contextWindow: 272_000, maxOutputTokens: 16_000, price: [0.1, 0.5, 0.01] },
  { id: 'openai/text-embedding-3-small', providerId: 'openai', modelKey: 'text-embedding-3-small', tier: 'fast', contextWindow: 8_191, maxOutputTokens: 0, price: [0.02, 0], modality: 'embedding', capabilities: [], dimensions: 1536 },
  // Google Gemini (Flash prices are promotional until 2026-12-31 per third-party sources)
  { id: 'google/gemini-3.8-flash', providerId: 'google', modelKey: 'gemini-3.8-flash', tier: 'balanced', contextWindow: 1_000_000, maxOutputTokens: 32_000, price: [0.75, 3.75, 0.075] },
  { id: 'google/gemini-3.1-flash-lite', providerId: 'google', modelKey: 'gemini-3.1-flash-lite', tier: 'fast', contextWindow: 1_000_000, maxOutputTokens: 16_000, price: [0.25, 1.5, 0.025] },
  // OpenRouter: the same Claude models through a second provider, with separate rate limits.
  { id: 'openrouter/anthropic/claude-sonnet-5.5', providerId: 'openrouter', modelKey: 'anthropic/claude-sonnet-5.5', tier: 'balanced', contextWindow: 200_000, maxOutputTokens: 32_000, price: [2, 10, 0.2] },
  { id: 'openrouter/anthropic/claude-haiku-5.5', providerId: 'openrouter', modelKey: 'anthropic/claude-haiku-5.5', tier: 'fast', contextWindow: 200_000, maxOutputTokens: 16_000, price: [0.1, 0.5, 0.01] },
];

const TIER_ORDER: Record<Tier, string[]> = {
  frontier: ['anthropic/claude-opus-5.5', 'openai/gpt-6-astra'],
  balanced: ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol', 'google/gemini-3.8-flash', 'openrouter/anthropic/claude-sonnet-5.5'],
  fast: ['anthropic/claude-haiku-5.5', 'openai/gpt-6-luna', 'google/gemini-3.1-flash-lite', 'openrouter/anthropic/claude-haiku-5.5'],
  local: ['ollama-pc/local'],
};

/** Kiro, through Kiro CLI, has no HTTP endpoint, no token metering (subscription credits) and no
 * image path; it declares tools/json via Feroxes's text protocol and reasoning, but not vision. */
const KIRO_CAPS: Capability[] = ['tools', 'streaming', 'json_schema', 'reasoning'];

export const ROUTES: RouteConfig[] = [
  { id: 'chat.turn', tier: 'auto', requiredCapabilities: ['streaming'], defaultPriority: 'interactive', allowEscalation: false },
  { id: 'agent.plan', tier: 'frontier', requiredCapabilities: [], defaultPriority: 'interactive', allowEscalation: false },
  { id: 'memory.extract', tier: 'fast', requiredCapabilities: ['json_schema'], defaultPriority: 'routine', allowEscalation: false, maxOutputTokens: 1500 },
  { id: 'memory.reconcile', tier: 'fast', requiredCapabilities: ['json_schema'], defaultPriority: 'routine', allowEscalation: false, maxOutputTokens: 400 },
  { id: 'memory.consolidate', tier: 'fast', requiredCapabilities: [], defaultPriority: 'deferrable', allowEscalation: false },
  { id: 'session.summarize', tier: 'fast', requiredCapabilities: [], defaultPriority: 'routine', allowEscalation: false, maxOutputTokens: 600 },
  { id: 'classify', tier: 'fast', requiredCapabilities: ['json_schema'], defaultPriority: 'important', allowEscalation: true, maxOutputTokens: 150 },
  // Brain: cheap models for the debate voices, a stronger one for the synthesis and reflection.
  { id: 'think.perspective', tier: 'fast', requiredCapabilities: [], defaultPriority: 'interactive', allowEscalation: false, maxOutputTokens: 350 },
  { id: 'think.synthesis', tier: 'balanced', requiredCapabilities: [], defaultPriority: 'interactive', allowEscalation: false, maxOutputTokens: 700 },
  { id: 'brain.reflect', tier: 'balanced', requiredCapabilities: ['json_schema'], defaultPriority: 'deferrable', allowEscalation: false, maxOutputTokens: 1500 },
  { id: 'brain.briefing', tier: 'fast', requiredCapabilities: [], defaultPriority: 'important', allowEscalation: false, maxOutputTokens: 700 },
];

export interface ResolvedCatalog {
  providers: ProviderEntry[];
  models: ModelEntry[];
  tiers: Partial<Record<Tier, string[]>>;
  routes: RouteConfig[];
  prices: ModelPrice[];
  keys: Map<string, string>;
}

/** Enables only the providers the owner has keys for. */
export function resolveCatalog(env: Env): ResolvedCatalog {
  const keys = new Map<string, string>();
  const providers: ProviderEntry[] = [];
  const add = (p: ProviderEntry, key?: string) => {
    providers.push(p);
    if (key) keys.set(p.id, key);
  };
  if (env.ANTHROPIC_API_KEY) add({ id: 'anthropic', kind: 'anthropic', name: 'Anthropic', enabled: true, maxSensitivity: 'private' }, env.ANTHROPIC_API_KEY);
  if (env.OPENAI_API_KEY) add({ id: 'openai', kind: 'openai', name: 'OpenAI', enabled: true, maxSensitivity: 'private' }, env.OPENAI_API_KEY);
  if (env.GEMINI_API_KEY) add({ id: 'google', kind: 'google', name: `Google Gemini (${env.GEMINI_TIER} tier)`, enabled: true, maxSensitivity: env.GEMINI_TIER === 'paid' ? 'private' : 'normal' }, env.GEMINI_API_KEY);
  if (env.OPENROUTER_API_KEY) add({ id: 'openrouter', kind: 'openai-compatible', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', headers: { 'X-Title': 'Feroxes' }, enabled: true, maxSensitivity: 'private' }, env.OPENROUTER_API_KEY);
  if (env.OLLAMA_BASE_URL) add({ id: 'ollama-pc', kind: 'openai-compatible', name: 'Ollama on the owner\'s PC', baseUrl: env.OLLAMA_BASE_URL, enabled: true, maxSensitivity: 'secret', timeouts: { firstTokenMs: 60_000, totalMs: 300_000 } });

  // Kiro as the main brain (owner's explicit choice). Driven through Kiro CLI on the PC; see
  // docs/07. Enabled when an API key is set, or when FEROXES_KIRO_BRAIN=true (an existing
  // `kiro-cli login` session is used if no key is given).
  const kiroOn = env.FEROXES_KIRO_BRAIN && (!!env.KIRO_API_KEY || env.FEROXES_KIRO_USE_LOGIN);
  if (kiroOn) {
    const settings = { command: env.KIRO_CLI_COMMAND, ...(env.KIRO_CLI_AGENT ? { extraArgs: ['--agent', env.KIRO_CLI_AGENT] } : {}) };
    add({ id: 'kiro', kind: 'kiro', name: 'Kiro (main brain)', enabled: true, maxSensitivity: 'private', settings, timeouts: { firstTokenMs: 120_000, totalMs: 600_000 } }, env.KIRO_API_KEY);
  }

  const enabled = new Set(providers.map((p) => p.id));
  const models: ModelEntry[] = SEEDS.filter((s) => enabled.has(s.providerId)).map((s) => ({
    id: s.id,
    providerId: s.providerId,
    modelKey: s.modelKey,
    displayName: s.id,
    modality: s.modality ?? 'chat',
    capabilities: s.capabilities ?? CHAT,
    contextWindow: s.contextWindow,
    maxOutputTokens: s.maxOutputTokens,
    tier: s.tier,
    enabled: true,
    ...(s.dimensions ? { dimensions: s.dimensions } : {}),
  }));
  if (enabled.has('ollama-pc')) {
    models.push({ id: 'ollama-pc/local', providerId: 'ollama-pc', modelKey: env.OLLAMA_MODEL, displayName: `Ollama ${env.OLLAMA_MODEL}`, modality: 'chat', capabilities: ['tools', 'streaming', 'json_schema'], contextWindow: 32_000, maxOutputTokens: 4_096, tier: 'local', enabled: true });
  }
  if (kiroOn) {
    // One Kiro model per reasoning tier. modelKey 'default' lets Kiro's agent choose; set
    // KIRO_FRONTIER_MODEL / KIRO_BALANCED_MODEL to pin specific Kiro models.
    models.push({ id: 'kiro/frontier', providerId: 'kiro', modelKey: env.KIRO_FRONTIER_MODEL || 'default', displayName: 'Kiro (frontier)', modality: 'chat', capabilities: KIRO_CAPS, contextWindow: 200_000, maxOutputTokens: 32_000, tier: 'frontier', enabled: true });
    models.push({ id: 'kiro/balanced', providerId: 'kiro', modelKey: env.KIRO_BALANCED_MODEL || 'default', displayName: 'Kiro (balanced)', modality: 'chat', capabilities: KIRO_CAPS, contextWindow: 200_000, maxOutputTokens: 16_000, tier: 'balanced', enabled: true });
    if (env.FEROXES_KIRO_SCOPE === 'all') models.push({ id: 'kiro/fast', providerId: 'kiro', modelKey: env.KIRO_BALANCED_MODEL || 'default', displayName: 'Kiro (fast)', modality: 'chat', capabilities: KIRO_CAPS, contextWindow: 200_000, maxOutputTokens: 8_000, tier: 'fast', enabled: true });
  }

  const ids = new Set(models.map((m) => m.id));
  const tiers = Object.fromEntries(Object.entries(TIER_ORDER).map(([tier, list]) => [tier, list.filter((id) => ids.has(id))])) as Partial<Record<Tier, string[]>>;
  // Kiro is the default and main brain: it goes first in every tier it serves, so the router
  // always tries it before the API models, which become fallback (owner's explicit choice).
  if (kiroOn) {
    tiers.frontier = ['kiro/frontier', ...(tiers.frontier ?? [])];
    tiers.balanced = ['kiro/balanced', ...(tiers.balanced ?? [])];
    if (env.FEROXES_KIRO_SCOPE === 'all') tiers.fast = ['kiro/fast', ...(tiers.fast ?? [])];
  }
  const prices: ModelPrice[] = SEEDS.filter((s) => ids.has(s.id)).map((s) => ({
    id: `seed-${s.id}`,
    modelId: s.id,
    effectiveFrom: Date.UTC(2026, 9, 1),
    inputPerMTok: s.price[0],
    outputPerMTok: s.price[1],
    ...(s.price[2] !== undefined ? { cachedInputPerMTok: s.price[2] } : {}),
  }));
  if (ids.has('ollama-pc/local')) prices.push({ id: 'seed-ollama', modelId: 'ollama-pc/local', effectiveFrom: 0, inputPerMTok: 0, outputPerMTok: 0 });
  // Kiro usage is billed as subscription credits, not per token: $0 in the token ledger. The
  // dashboard shows Kiro call counts; credits are tracked in Kiro's own /usage.
  for (const id of ['kiro/frontier', 'kiro/balanced', 'kiro/fast']) if (ids.has(id)) prices.push({ id: `seed-${id}`, modelId: id, effectiveFrom: 0, inputPerMTok: 0, outputPerMTok: 0 });

  // With Kiro as the brain and the default "reasoning" scope, conversation must still reach Kiro:
  // floor chat.turn at the balanced tier (where Kiro sits) instead of letting trivial turns drop
  // to the fast/API tier. With scope "all", Kiro is in the fast tier too, so keep auto.
  const routes = ROUTES.map((r) => (r.id === 'chat.turn' && kiroOn && env.FEROXES_KIRO_SCOPE !== 'all' ? { ...r, tier: 'balanced' as Tier } : r));
  return { providers, models, tiers, routes, prices, keys };
}
