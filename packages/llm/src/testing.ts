import {
  type Budget,
  BudgetGate,
  InMemoryBudgetStore,
  InMemoryUsageLedgerStore,
  type ModelPrice,
  PriceBook,
  UsageLedger,
} from '@feroxes/metering';
import { ManualClock, type PowerMode, type Sensitivity, type SystemState, type Tier } from '@feroxes/shared';
import { MockAdapter } from './adapters/mock.ts';
import { Catalog } from './catalog.ts';
import { CostEstimator } from './estimator.ts';
import { HealthTracker } from './health.ts';
import { ModelRouter } from './router.ts';
import type { Capability, ModelEntry, ProviderEntry, ProviderKind, RouteConfig } from './types.ts';

/**
 * A complete router wired to mock providers, for tests and keyless demos.
 * Providers mirror the owner's real setup: Anthropic, OpenAI, Google, OpenRouter.
 */
export function createTestRouter(options: {
  budgets?: Budget[];
  clock?: ManualClock;
  powerMode?: () => PowerMode;
  systemState?: () => SystemState;
  googleMaxSensitivity?: Sensitivity;
  timeouts?: { firstTokenMs: number; totalMs: number };
} = {}) {
  const clock = options.clock ?? new ManualClock(Date.UTC(2026, 10, 7, 12));
  const chat: Capability[] = ['tools', 'streaming', 'json_schema', 'vision', 'prompt_cache'];

  const providers: ProviderEntry[] = [
    { id: 'anthropic', kind: 'anthropic', name: 'Anthropic', enabled: true, maxSensitivity: 'private' },
    { id: 'openai', kind: 'openai', name: 'OpenAI', enabled: true, maxSensitivity: 'private' },
    { id: 'google', kind: 'google', name: 'Google (free tier)', enabled: true, maxSensitivity: options.googleMaxSensitivity ?? 'normal' },
    { id: 'openrouter', kind: 'openai-compatible', name: 'OpenRouter', enabled: true, maxSensitivity: 'private' },
  ];

  const m = (id: string, providerId: string, tier: Tier, extra: Partial<ModelEntry> = {}): ModelEntry => ({
    id,
    providerId,
    modelKey: id.split('/').slice(1).join('/'),
    displayName: id,
    modality: 'chat',
    capabilities: chat,
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    tier,
    enabled: true,
    ...extra,
  });

  const models: ModelEntry[] = [
    m('anthropic/opus', 'anthropic', 'frontier'),
    m('openai/astra', 'openai', 'frontier'),
    m('anthropic/sonnet', 'anthropic', 'balanced'),
    m('openai/sol', 'openai', 'balanced'),
    m('google/flash', 'google', 'balanced'),
    m('openrouter/sonnet', 'openrouter', 'balanced'),
    m('anthropic/haiku', 'anthropic', 'fast'),
    m('openai/luna', 'openai', 'fast'),
    m('google/flash-lite', 'google', 'fast', { capabilities: ['streaming', 'json_schema'] }),
    { ...m('openai/embed-small', 'openai', 'fast'), modality: 'embedding', capabilities: [], dimensions: 64 },
  ];

  const tiers: Partial<Record<Tier, string[]>> = {
    frontier: ['anthropic/opus', 'openai/astra'],
    balanced: ['anthropic/sonnet', 'openai/sol', 'google/flash', 'openrouter/sonnet'],
    fast: ['anthropic/haiku', 'openai/luna', 'google/flash-lite'],
  };

  const routes: RouteConfig[] = [
    { id: 'chat.turn', tier: 'auto', requiredCapabilities: ['streaming'], defaultPriority: 'interactive', allowEscalation: false },
    { id: 'agent.plan', tier: 'frontier', requiredCapabilities: [], defaultPriority: 'interactive', allowEscalation: false },
    { id: 'memory.extract', tier: 'fast', requiredCapabilities: ['json_schema'], defaultPriority: 'routine', allowEscalation: false, maxOutputTokens: 1500 },
    { id: 'memory.reconcile', tier: 'fast', requiredCapabilities: ['json_schema'], defaultPriority: 'routine', allowEscalation: false, maxOutputTokens: 400 },
    { id: 'memory.consolidate', tier: 'fast', requiredCapabilities: [], defaultPriority: 'deferrable', allowEscalation: false },
    { id: 'session.summarize', tier: 'fast', requiredCapabilities: [], defaultPriority: 'routine', allowEscalation: false },
    { id: 'classify', tier: 'fast', requiredCapabilities: ['json_schema'], defaultPriority: 'important', allowEscalation: true },
    { id: 'think.perspective', tier: 'fast', requiredCapabilities: [], defaultPriority: 'interactive', allowEscalation: false, maxOutputTokens: 350 },
    { id: 'think.synthesis', tier: 'balanced', requiredCapabilities: [], defaultPriority: 'interactive', allowEscalation: false, maxOutputTokens: 700 },
    { id: 'brain.reflect', tier: 'balanced', requiredCapabilities: ['json_schema'], defaultPriority: 'deferrable', allowEscalation: false, maxOutputTokens: 1500 },
    { id: 'brain.briefing', tier: 'fast', requiredCapabilities: [], defaultPriority: 'important', allowEscalation: false, maxOutputTokens: 700 },
  ];

  const price = (modelId: string, input: number, output: number, cached = input / 10): ModelPrice => ({ id: `price-${modelId}`, modelId, effectiveFrom: 0, inputPerMTok: input, outputPerMTok: output, cachedInputPerMTok: cached });
  const prices = new PriceBook([
    price('anthropic/opus', 4, 20),
    price('openai/astra', 10, 50),
    price('anthropic/sonnet', 2, 10),
    price('openai/sol', 2, 10),
    price('google/flash', 0.75, 3.75),
    price('openrouter/sonnet', 2, 10),
    price('anthropic/haiku', 0.1, 0.5),
    price('openai/luna', 0.1, 0.5),
    price('google/flash-lite', 0.1, 0.4),
    price('openai/embed-small', 0.02, 0),
  ]);

  const adapters = new Map<string, MockAdapter>(providers.map((p) => [p.id, new MockAdapter()]));
  const catalog = new Catalog({ providers, models, tiers, routes });
  const ledgerStore = new InMemoryUsageLedgerStore();
  const ledger = new UsageLedger({ store: ledgerStore, prices, clock });
  const budgetStore = new InMemoryBudgetStore(options.budgets ?? []);
  const budget = new BudgetGate({
    store: budgetStore,
    timeZone: 'UTC',
    clock,
    safetyFactor: 1,
    ...(options.powerMode ? { powerMode: options.powerMode } : {}),
    ...(options.systemState ? { systemState: options.systemState } : {}),
  });
  const health = new HealthTracker({ clock });
  const estimator = new CostEstimator();
  const waits: number[] = [];
  const router = new ModelRouter({
    catalog,
    adapters: adapters as Map<string, MockAdapter>,
    health,
    ledger,
    budget,
    prices,
    estimator,
    clock,
    wait: async (ms) => {
      waits.push(ms);
    },
    ...(options.timeouts ? { timeouts: { interactive: options.timeouts, background: options.timeouts } } : {}),
  });

  const adapter = (providerId: string): MockAdapter => adapters.get(providerId)!;
  return { router, catalog, adapters, adapter, ledger, ledgerStore, budget, budgetStore, health, prices, estimator, clock, waits };
}

export type TestRouter = ReturnType<typeof createTestRouter>;
export type { ProviderKind };
