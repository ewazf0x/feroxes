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
  const ids = new Set(models.map((m) => m.id));
  const tiers = Object.fromEntries(Object.entries(TIER_ORDER).map(([tier, list]) => [tier, list.filter((id) => ids.has(id))])) as Partial<Record<Tier, string[]>>;
  const prices: ModelPrice[] = SEEDS.filter((s) => ids.has(s.id)).map((s) => ({
    id: `seed-${s.id}`,
    modelId: s.id,
    effectiveFrom: Date.UTC(2026, 9, 1),
    inputPerMTok: s.price[0],
    outputPerMTok: s.price[1],
    ...(s.price[2] !== undefined ? { cachedInputPerMTok: s.price[2] } : {}),
  }));
  if (ids.has('ollama-pc/local')) prices.push({ id: 'seed-ollama', modelId: 'ollama-pc/local', effectiveFrom: 0, inputPerMTok: 0, outputPerMTok: 0 });
  return { providers, models, tiers, prices, keys };
}
