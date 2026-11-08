import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AgentRuntime, type AgentEvents, ContextBuilder, memoryTools } from '@feroxes/agent';
import { createBrain } from '@feroxes/brain';
import { DeviceHub, type DeviceRecord, type DeviceRegistry, createDeviceTools, deviceToolsets } from '@feroxes/devices';
import { Catalog, CostEstimator, HealthTracker, ModelRouter, type ProviderAdapter, createAdapter } from '@feroxes/llm';
import { ConsolidationService, ExtractionService, MemoryService, routerEmbedder } from '@feroxes/memory';
import { type Budget, BudgetGate, type ModelPrice, PowerModeController, PriceBook, SpendAnomalyDetector, UsageLedger } from '@feroxes/metering';
import { ApprovalService, AuditLog, PolicyEngine, SystemControl } from '@feroxes/policy';
import { type Clock, InMemoryEventBus, type Logger, MINUTE, createJsonLogger, systemClock, usd } from '@feroxes/shared';
import { openStores } from '@feroxes/store-sqlite';
import { InMemoryPlanStore, ToolRegistry, ToolRuntime, fileTools, notifyOwner, planUpdate, timeNow, webFetch } from '@feroxes/tools';
import { AsyncQueue, type ConversationPort, ElevenLabsStt, ElevenLabsTts, VoiceService } from '@feroxes/voice';
import { ROUTES, resolveCatalog } from './catalog.ts';
import type { Env } from './config.ts';

export interface Notification {
  title: string;
  body: string;
  urgency: 'low' | 'normal' | 'high';
  at: number;
}

// ElevenLabs list prices from third-party summaries (docs/02 §3.2): Flash TTS $0.05 per 1k
// characters, Scribe STT $0.22 per audio hour. Check against your plan; edit in config later.
const VOICE_PRICES = (tts: string, stt: string): ModelPrice[] => [
  { id: 'seed-el-tts', modelId: `elevenlabs/${tts}`, effectiveFrom: Date.UTC(2026, 9, 1), inputPerMTok: 0, outputPerMTok: 0, unitPrice: 0.05 / 1000 },
  { id: 'seed-el-stt', modelId: `elevenlabs/${stt}`, effectiveFrom: Date.UTC(2026, 9, 1), inputPerMTok: 0, outputPerMTok: 0, unitPrice: 0.22 / 3600 },
];

/**
 * Composition root. On the owner's PC everything lives in one SQLite file
 * (FEROXES_DATA_DIR/feroxes.db), so memory, goals, the self-model, budgets and the audit log
 * survive restarts. Pass dbPath ':memory:' for demos and tests.
 */
export async function createFeroxes(env: Env, opts: { clock?: Clock; logger?: Logger; adapters?: Map<string, ProviderAdapter>; catalog?: ReturnType<typeof resolveCatalog>; dbPath?: string; fetch?: typeof fetch } = {}) {
  const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? createJsonLogger({ level: 'warn' });
  const resolved = opts.catalog ?? resolveCatalog(env);
  if (resolved.providers.length === 0) throw new Error('No AI provider configured. Set at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, OLLAMA_BASE_URL.');

  const dataDir = resolve(env.FEROXES_DATA_DIR);
  const dbPath = opts.dbPath ?? join(dataDir, 'feroxes.db');
  const budgets: Budget[] = [
    { id: 'global-month', name: 'Global monthly', scope: { type: 'global' }, period: 'month', limit: usd(env.FEROXES_MONTHLY_BUDGET_USD), softThresholds: [50, 80, 95], onLimit: { interactive: 'ask', background: 'defer' }, enabled: true },
    { id: 'global-day', name: 'Global daily', scope: { type: 'global' }, period: 'day', limit: usd(env.FEROXES_DAILY_BUDGET_USD), interactiveReserve: usd(env.FEROXES_DAILY_BUDGET_USD * 0.25), softThresholds: [50, 80, 95], onLimit: { interactive: 'ask', background: 'defer' }, enabled: true },
    { id: 'background-day', name: 'Background daily', scope: { type: 'priority', priorities: ['routine', 'deferrable'] }, period: 'day', limit: usd(env.FEROXES_BACKGROUND_DAILY_USD), softThresholds: [80], onLimit: { interactive: 'ask', background: 'defer' }, enabled: true },
  ];
  const stores = openStores(dbPath, budgets);

  const catalog = new Catalog({ providers: resolved.providers, models: resolved.models, tiers: resolved.tiers, routes: resolved.routes });
  const adapters = opts.adapters ?? new Map(resolved.providers.map((p) => [p.id, createAdapter(p, resolved.keys.get(p.id))]));

  const notifications: Notification[] = [];
  const notificationListeners = new Set<(n: Notification) => void>();
  const notify = (n: Omit<Notification, 'at'>) => {
    const full = { ...n, at: clock.now() };
    notifications.push(full);
    if (notifications.length > 200) notifications.shift();
    for (const l of notificationListeners) l(full);
  };

  // ---- control and metering ----
  const system = new SystemControl({ store: stores.system, clock });
  await system.init();
  const power = new PowerModeController('normal', clock);
  const prices = new PriceBook([...resolved.prices, ...VOICE_PRICES(env.ELEVENLABS_TTS_MODEL, env.ELEVENLABS_STT_MODEL)]);
  const ledger = new UsageLedger({ store: stores.ledger, prices, clock });
  const budget = new BudgetGate({
    store: stores.budgets,
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
  const health = new HealthTracker({ clock });
  const router = new ModelRouter({ catalog, adapters, health, ledger, budget, prices, estimator: new CostEstimator(), clock, logger });

  // ---- memory ----
  const embeddingModel = catalog.embeddingModel();
  const memory = new MemoryService({ store: stores.memory, ...(embeddingModel ? { embedder: routerEmbedder(router, embeddingModel.id) } : {}), clock });
  const extraction = new ExtractionService({ router, memory, clock });
  const consolidation = new ConsolidationService({ router, memory, clock });

  // ---- devices: the hub's signing key is persisted, because paired apps pin its public key ----
  const registry: DeviceRegistry = { put: async (d) => stores.docs.put('device', d), list: async () => stores.docs.list<DeviceRecord>('device') };
  const savedKey = stores.docs.get<{ id: string; pkcs8: string }>('secret', 'device_signing_key');
  const hub = new DeviceHub({ registry, system, clock, logger, ...(savedKey ? { signingKeyPkcs8: savedKey.pkcs8 } : {}) });
  if (!savedKey) stores.docs.put('secret', { id: 'device_signing_key', pkcs8: hub.exportSigningKey() });
  await hub.init();

  // ---- policy and tools ----
  const policy = new PolicyEngine({ config: { preset: env.FEROXES_PRESET }, system, now: () => clock.now() });
  const approvals = new ApprovalService({ store: stores.approvals, clock });
  const audit = new AuditLog({ store: stores.audit, clock });
  const workspace = resolve(env.FEROXES_WORKSPACE_DIR);
  mkdirSync(workspace, { recursive: true });
  const tools = new ToolRegistry();
  tools.register(timeNow).register(planUpdate(new InMemoryPlanStore())).register(notifyOwner((n) => notify(n))).register(webFetch());
  for (const t of [...fileTools(workspace), ...memoryTools(memory), ...createDeviceTools(hub)]) tools.register(t);
  const toolRuntime = new ToolRuntime({ registry: tools, policy, approvals, audit, system, calls: stores.toolCalls, artifacts: stores.artifacts, timeZone: env.FEROXES_TIMEZONE, clock, logger, notify: (n) => notify({ ...n, urgency: 'low' }) });

  // ---- agent + brain ----
  const events = new InMemoryEventBus<AgentEvents>({ now: () => clock.now(), onHandlerError: (e, topic) => logger.error('event handler failed', { topic, error: String(e) }) });
  let runtime!: AgentRuntime;
  let voice: VoiceService | undefined;
  const brain = createBrain({
    docs: stores.docs,
    router,
    store: stores.agent,
    memory,
    audit,
    approvals,
    system,
    budget,
    hub,
    runtime: () => runtime,
    notify,
    speak: async (text) => {
      if (!voice) return;
      for await (const _ of voice.speak(text)) {
        // Audio delivery to the apps arrives with the app connection (next milestone).
      }
    },
    clock,
    timeZone: env.FEROXES_TIMEZONE,
    ...(env.FEROXES_OWNER_NAME ? { ownerName: env.FEROXES_OWNER_NAME } : {}),
    logger,
  });
  brain.self.recordBoot();
  for (const t of brain.tools) tools.register(t);
  const context = new ContextBuilder({
    memory,
    store: stores.agent,
    router,
    clock,
    timeZone: env.FEROXES_TIMEZONE,
    ...(env.FEROXES_OWNER_NAME ? { ownerName: env.FEROXES_OWNER_NAME } : {}),
    stableContext: () => brain.stableContext(),
    turnContext: (q, s) => brain.turnContext(q, s),
  });

  // Debounced memory extraction after interactive turns (Phase 1 plan §7.8).
  const pendingExtraction = new Map<string, NodeJS.Timeout>();
  const extractNow = async (sessionId: string) => {
    if (!(await budget.admit('routine')).admitted) return;
    const marker = stores.docs.get<{ id: string; seq: number }>('extracted', sessionId);
    const all = await stores.agent.messages(sessionId);
    const fresh = all.filter((m) => m.seq > (marker?.seq ?? 0) && (m.role === 'user' || (m.role === 'assistant' && m.content)));
    if (fresh.length === 0) return;
    stores.docs.put('extracted', { id: sessionId, seq: all.at(-1)!.seq });
    try {
      await extraction.process({ sessionId, messages: fresh.map((m) => ({ id: m.id, role: m.role as 'user' | 'assistant', content: m.content, createdAt: m.createdAt })) });
    } catch (error) {
      logger.warn('memory extraction failed', { sessionId, error: String(error) });
    }
  };
  runtime = new AgentRuntime({
    store: stores.agent,
    router,
    tools: toolRuntime,
    registry: tools,
    context,
    system,
    approvals,
    events,
    clock,
    logger,
    toolsets: () => ['memory', 'time', 'plan', 'notify', 'files', 'web', ...brain.toolsets, ...deviceToolsets(hub)],
    onTurnComplete: ({ sessionId }) => {
      clearTimeout(pendingExtraction.get(sessionId));
      pendingExtraction.set(sessionId, setTimeout(() => void extractNow(sessionId), 2 * MINUTE).unref());
    },
  });

  // ---- voice ----
  if (env.ELEVENLABS_API_KEY) {
    const f = opts.fetch ? { fetch: opts.fetch } : {};
    const port: ConversationPort = {
      async send(sessionId, text) {
        const q = new AsyncQueue<string>();
        const { runId, done } = await runtime.sendMessage(sessionId, text);
        const off = events.subscribe('run.delta', (e) => e.payload.runId === runId && q.push(e.payload.text));
        const finished = done.then(async (run) => {
          off();
          q.close();
          const approval = run.waitingApprovalId ? await approvals.get(run.waitingApprovalId) : undefined;
          return { status: run.status, ...(approval ? { approvalTitle: approval.preview.title } : {}) };
        });
        return { runId, deltas: q, done: finished };
      },
      stop: async (reason) => void (await system.stop('owner', reason)),
    };
    voice = new VoiceService({
      stt: new ElevenLabsStt({ apiKey: env.ELEVENLABS_API_KEY, model: env.ELEVENLABS_STT_MODEL, ...f }),
      tts: new ElevenLabsTts({ apiKey: env.ELEVENLABS_API_KEY, voiceId: env.ELEVENLABS_VOICE_ID, model: env.ELEVENLABS_TTS_MODEL, ...f }),
      port,
      budget,
      ledger,
      prices,
      clock,
    });
  }

  // ---- background daemons ----
  brain.scheduler.add({ name: 'budget.sweep', every: MINUTE, priority: 'none', run: () => budget.sweepExpired() });
  brain.scheduler.add({ name: 'devices.sweep', every: MINUTE, priority: 'none', run: async () => hub.sweep() });
  brain.scheduler.add({
    name: 'spend.anomaly',
    every: 5 * MINUTE,
    priority: 'none',
    run: async () => {
      const r = await anomaly.check();
      if (r.anomalous && power.set('economy', 'system', 'spend spike')) notify({ title: 'Spending spike: switched to economy mode', body: `Last hour: $${(r.lastHour / 1e9).toFixed(3)}`, urgency: 'high' });
      return r.anomalous;
    },
  });
  brain.scheduler.add({ name: 'memory.nightly', dailyAt: '03:30', priority: 'deferrable', run: () => consolidation.nightly() });
  if (dbPath !== ':memory:') {
    brain.scheduler.add({
      name: 'backup.nightly',
      dailyAt: '04:00',
      priority: 'none',
      runWhenStopped: true,
      run: async () => {
        const dir = join(dataDir, 'backups');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `feroxes-${new Date(clock.now()).toISOString().slice(0, 10)}.db`);
        stores.db.backupTo(file);
        return file;
      },
    });
  }

  return {
    env,
    clock,
    db: stores.db,
    stores,
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
    registry: tools,
    tools: toolRuntime,
    runtime,
    events,
    agentStore: stores.agent,
    hub,
    brain,
    voice,
    notifications,
    onNotification(cb: (n: Notification) => void) {
      notificationListeners.add(cb);
      return () => notificationListeners.delete(cb);
    },
    workspace,
    async flushMemory(sessionId: string) {
      clearTimeout(pendingExtraction.get(sessionId));
      pendingExtraction.delete(sessionId);
      await extractNow(sessionId);
    },
    async shutdown() {
      for (const t of pendingExtraction.values()) clearTimeout(t);
      stores.db.close();
    },
  };
}

export type Feroxes = Awaited<ReturnType<typeof createFeroxes>>;
