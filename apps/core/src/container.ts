import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentRuntime, ContextBuilder, type AgentEvents, InMemoryAgentStore, memoryTools } from '@feroxes/agent';
import { Catalog, CostEstimator, HealthTracker, ModelRouter, type ProviderAdapter, createAdapter } from '@feroxes/llm';
import { ConsolidationService, ExtractionService, InMemoryMemoryStore, MemoryService, routerEmbedder } from '@feroxes/memory';
import { type Budget, BudgetGate, InMemoryBudgetStore, InMemoryUsageLedgerStore, PowerModeController, PriceBook, SpendAnomalyDetector, UsageLedger } from '@feroxes/metering';
import { ApprovalService, AuditLog, InMemoryApprovalStore, InMemoryAuditStore, InMemorySystemStateStore, PolicyEngine, SystemControl } from '@feroxes/policy';
import { type Clock, InMemoryEventBus, type Logger, MINUTE, createJsonLogger, systemClock, usd } from '@feroxes/shared';
import { InMemoryArtifactStore, InMemoryPlanStore, InMemoryToolCallStore, ToolRegistry, ToolRuntime, fileTools, notifyOwner, planUpdate, timeNow, webFetch } from '@feroxes/tools';
import { ROUTES, resolveCatalog } from './catalog.ts';
import type { Env } from './config.ts';

export interface Notification {
  title: string;
  body: string;
  urgency: 'low' | 'normal' | 'high';
  at: number;
}

/**
 * Composition root: builds every service and wires them together (manual dependency injection).
 * Stores are in-memory until the Postgres implementations land (next milestone); every store sits
 * behind an interface, so swapping them doesn't touch the domain packages.
 */
export async function createFeroxes(env: Env, opts: { clock?: Clock; logger?: Logger; adapters?: Map<string, ProviderAdapter>; catalog?: ReturnType<typeof resolveCatalog> } = {}) {
  const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? createJsonLogger({ level: 'warn' });
  const resolved = opts.catalog ?? resolveCatalog(env);
  if (resolved.providers.length === 0) throw new Error('No AI provider configured. Set at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, OLLAMA_BASE_URL.');

  const catalog = new Catalog({ providers: resolved.providers, models: resolved.models, tiers: resolved.tiers, routes: ROUTES });
  const adapters = opts.adapters ?? new Map(resolved.providers.map((p) => [p.id, createAdapter(p, resolved.keys.get(p.id))]));

  // ---- metering ----
  const prices = new PriceBook(resolved.prices);
  const ledger = new UsageLedger({ store: new InMemoryUsageLedgerStore(), prices, clock });
  const budgets: Budget[] = [
    { id: 'global-month', name: 'Global monthly', scope: { type: 'global' }, period: 'month', limit: usd(env.FEROXES_MONTHLY_BUDGET_USD), softThresholds: [50, 80, 95], onLimit: { interactive: 'ask', background: 'defer' }, enabled: true },
    { id: 'global-day', name: 'Global daily', scope: { type: 'global' }, period: 'day', limit: usd(env.FEROXES_DAILY_BUDGET_USD), interactiveReserve: usd(env.FEROXES_DAILY_BUDGET_USD * 0.25), softThresholds: [50, 80, 95], onLimit: { interactive: 'ask', background: 'defer' }, enabled: true },
    { id: 'background-day', name: 'Background daily', scope: { type: 'priority', priorities: ['routine', 'deferrable'] }, period: 'day', limit: usd(env.FEROXES_BACKGROUND_DAILY_USD), softThresholds: [80], onLimit: { interactive: 'ask', background: 'defer' }, enabled: true },
  ];
  const notifications: Notification[] = [];
  const notify = (n: Omit<Notification, 'at'>) => notifications.push({ ...n, at: clock.now() });

  const systemStore = new InMemorySystemStateStore();
  const system = new SystemControl({ store: systemStore, clock });
  await system.init();
  const power = new PowerModeController('normal', clock);
  const budget = new BudgetGate({
    store: new InMemoryBudgetStore(budgets),
    timeZone: env.FEROXES_TIMEZONE,
    clock,
    powerMode: () => power.mode,
    systemState: () => system.state,
    onThreshold: (a) => {
      notify({ title: `Budget "${a.budgetName}" at ${a.threshold}%`, body: `Spent $${(a.spent / 1e9).toFixed(4)} of $${(a.limit / 1e9).toFixed(2)}.`, urgency: a.threshold >= 95 ? 'high' : 'normal' });
      if (a.threshold >= 80) power.set('economy', 'system', `budget "${a.budgetName}" reached ${a.threshold}%`);
    },
  });
  const anomaly = new SpendAnomalyDetector({ ledger, clock });

  // ---- intelligence ----
  const health = new HealthTracker({ clock });
  const router = new ModelRouter({ catalog, adapters, health, ledger, budget, prices, estimator: new CostEstimator(), clock, logger });

  // ---- memory ----
  const embeddingModel = catalog.embeddingModel();
  const memory = new MemoryService({ store: new InMemoryMemoryStore(), ...(embeddingModel ? { embedder: routerEmbedder(router, embeddingModel.id) } : {}), clock });
  const extraction = new ExtractionService({ router, memory, clock });
  const consolidation = new ConsolidationService({ router, memory, clock });

  // ---- policy and tools ----
  const policy = new PolicyEngine({ config: { preset: env.FEROXES_PRESET }, system });
  const approvals = new ApprovalService({ store: new InMemoryApprovalStore(), clock });
  const audit = new AuditLog({ store: new InMemoryAuditStore(), clock });
  const workspace = resolve(env.FEROXES_WORKSPACE_DIR);
  mkdirSync(workspace, { recursive: true });
  const registry = new ToolRegistry();
  registry.register(timeNow).register(planUpdate(new InMemoryPlanStore())).register(notifyOwner((n) => notify(n))).register(webFetch());
  for (const t of [...fileTools(workspace), ...memoryTools(memory)]) registry.register(t);
  const tools = new ToolRuntime({ registry, policy, approvals, audit, system, calls: new InMemoryToolCallStore(), artifacts: new InMemoryArtifactStore(), timeZone: env.FEROXES_TIMEZONE, clock, logger, notify: (n) => notify({ ...n, urgency: 'low' }) });

  // ---- agent ----
  const events = new InMemoryEventBus<AgentEvents>({ now: () => clock.now(), onHandlerError: (e, topic) => logger.error('event handler failed', { topic, error: String(e) }) });
  const agentStore = new InMemoryAgentStore();
  const context = new ContextBuilder({ memory, store: agentStore, router, clock, timeZone: env.FEROXES_TIMEZONE, ...(env.FEROXES_OWNER_NAME ? { ownerName: env.FEROXES_OWNER_NAME } : {}) });

  // Debounced memory extraction after interactive turns (Phase 1 plan §7.8).
  const pendingExtraction = new Map<string, NodeJS.Timeout>();
  const extractedThrough = new Map<string, number>();
  const extractNow = async (sessionId: string) => {
    const admission = await budget.admit('routine');
    if (!admission.admitted) return;
    const all = await agentStore.messages(sessionId);
    const fresh = all.filter((m) => m.seq > (extractedThrough.get(sessionId) ?? 0) && (m.role === 'user' || (m.role === 'assistant' && m.content)));
    if (fresh.length === 0) return;
    extractedThrough.set(sessionId, all.at(-1)!.seq);
    try {
      await extraction.process({ sessionId, messages: fresh.map((m) => ({ id: m.id, role: m.role as 'user' | 'assistant', content: m.content, createdAt: m.createdAt })) });
    } catch (error) {
      logger.warn('memory extraction failed', { sessionId, error: String(error) });
    }
  };
  const runtime = new AgentRuntime({
    store: agentStore,
    router,
    tools,
    registry,
    context,
    system,
    approvals,
    events,
    clock,
    logger,
    onTurnComplete: ({ sessionId }) => {
      clearTimeout(pendingExtraction.get(sessionId));
      pendingExtraction.set(sessionId, setTimeout(() => void extractNow(sessionId), 2 * MINUTE).unref());
    },
  });

  return {
    env,
    clock,
    catalog,
    router,
    ledger,
    budget,
    power,
    anomaly,
    health,
    memory,
    extraction,
    consolidation,
    system,
    policy,
    approvals,
    audit,
    registry,
    tools,
    runtime,
    events,
    agentStore,
    notifications,
    workspace,
    /** Flushes pending extraction (e.g. on exit or session idle). */
    async flushMemory(sessionId: string) {
      clearTimeout(pendingExtraction.get(sessionId));
      pendingExtraction.delete(sessionId);
      await extractNow(sessionId);
    },
    async shutdown() {
      for (const t of pendingExtraction.values()) clearTimeout(t);
    },
  };
}

export type Feroxes = Awaited<ReturnType<typeof createFeroxes>>;
