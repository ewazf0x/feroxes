import {
  type BudgetGate,
  type PriceBook,
  type ReserveResult,
  type TokenUsage,
  type UsageLedger,
} from '@feroxes/metering';
import {
  type Clock,
  type Logger,
  type PriorityClass,
  type Tier,
  anySignal,
  backoffMs,
  isBackground,
  nextTierUp,
  noopLogger,
  sensitivityRank,
  sleep,
  systemClock,
  throwIfAborted,
  tierRank,
  uuidv7,
} from '@feroxes/shared';
import type { Catalog } from './catalog.ts';
import { type ComplexityDecision, classifyComplexity } from './classifier.ts';
import {
  AllCandidatesFailedError,
  BudgetApprovalNeededError,
  BudgetBlockedError,
  DeferredError,
  NoCandidatesError,
  ProviderError,
  classifyThrown,
} from './errors.ts';
import { type CostEstimator, messageChars } from './estimator.ts';
import type { HealthTracker } from './health.ts';
import {
  type AdapterRequest,
  type Attempt,
  type Capability,
  type ErrorClass,
  type FinishReason,
  type LlmMessage,
  type LlmRequest,
  type LlmResult,
  type ModelEntry,
  NO_SAME_MODEL_RETRY,
  type ProviderAdapter,
  type ProviderEntry,
  RETRYABLE,
  type RouteConfig,
  type RouterEvent,
  type ToolCall,
} from './types.ts';

export interface Candidate {
  model: ModelEntry;
  provider: ProviderEntry;
  adapter: ProviderAdapter;
  tier: Tier;
}

export interface RoutePlan {
  route: RouteConfig;
  priority: PriorityClass;
  tier: Tier;
  decision?: ComplexityDecision;
  candidates: Candidate[];
  excluded: { modelId: string; reason: string }[];
}

export interface Timeouts {
  firstTokenMs: number;
  totalMs: number;
}

export interface RouterOptions {
  catalog: Catalog;
  /** Adapters keyed by provider id (each provider instance has its own base URL and key). */
  adapters: Map<string, ProviderAdapter>;
  health: HealthTracker;
  ledger: UsageLedger;
  budget: BudgetGate;
  prices: PriceBook;
  estimator: CostEstimator;
  clock?: Clock;
  logger?: Logger;
  timeouts?: { interactive: Timeouts; background: Timeouts };
  sameModelRetries?: { interactive: number; background: number };
  /** Injectable for tests. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_TIMEOUTS = {
  interactive: { firstTokenMs: 20_000, totalMs: 180_000 },
  background: { firstTokenMs: 60_000, totalMs: 300_000 },
};

class TimeoutAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * The only way Feroxes talks to a model (architecture §8). Resolves a route to candidates,
 * reserves budget, streams, fails over, records every attempt in the ledger, and settles cost.
 */
export class ModelRouter {
  private readonly o: Required<Omit<RouterOptions, 'wait'>> & { wait: (ms: number, signal?: AbortSignal) => Promise<void> };

  constructor(options: RouterOptions) {
    this.o = {
      clock: systemClock,
      logger: noopLogger,
      timeouts: DEFAULT_TIMEOUTS,
      sameModelRetries: { interactive: 0, background: 2 },
      wait: sleep,
      ...options,
    };
  }

  plan(req: LlmRequest): RoutePlan {
    const { catalog } = this.o;
    const route = catalog.route(req.route);
    if (!route) throw new NoCandidatesError(req.route, 'unknown route');
    const priority = req.priority ?? route.defaultPriority;

    let decision: ComplexityDecision | undefined;
    let tier: Tier;
    const requested = req.tier ?? route.tier;
    if (requested === 'auto') {
      decision = classifyComplexity(req.messages);
      tier = decision.tier;
    } else {
      tier = requested;
    }
    if (req.tierCap && tierRank(tier) > tierRank(req.tierCap)) tier = req.tierCap;

    // Ordered candidate ids: the tier list, then (if allowed) one tier up, then for
    // owner-facing work one tier down: a cheaper answer beats no answer.
    const ids: { id: string; tier: Tier }[] = [];
    const push = (list: string[], t: Tier) => list.forEach((id) => ids.push({ id, tier: t }));
    if (route.candidates?.length) {
      for (const id of route.candidates) push([id], catalog.model(id)?.tier ?? tier);
    } else {
      push(catalog.tier(tier), tier);
      const up = nextTierUp(tier);
      const capOk = (t: Tier) => !req.tierCap || tierRank(t) <= tierRank(req.tierCap);
      if (route.allowEscalation && up && capOk(up)) push(catalog.tier(up), up);
      if (priority === 'interactive' || priority === 'important') {
        const down = tier === 'frontier' ? 'balanced' : tier === 'balanced' ? 'fast' : undefined;
        if (down) push(catalog.tier(down), down);
      }
    }

    const needs = new Set<Capability>(route.requiredCapabilities);
    if (req.tools?.length) needs.add('tools');
    if (req.output) needs.add('json_schema');
    if (req.messages.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'image'))) needs.add('vision');

    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    const excluded: RoutePlan['excluded'] = [];
    for (const { id, tier: t } of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const model = catalog.model(id);
      const provider = model ? catalog.provider(model.providerId) : undefined;
      const adapter = provider ? this.o.adapters.get(provider.id) : undefined;
      const reason = !model
        ? 'not in catalog'
        : !model.enabled || model.modality !== 'chat'
          ? 'disabled or not a chat model'
          : !provider || !provider.enabled
            ? 'provider disabled'
            : !adapter
              ? 'no adapter configured'
              : [...needs].find((c) => !model.capabilities.includes(c))
                ? `missing capability ${[...needs].find((c) => !model.capabilities.includes(c))}`
                : sensitivityRank(provider.maxSensitivity) < sensitivityRank(req.sensitivity)
                  ? `provider may not receive ${req.sensitivity} data`
                  : this.estimateInput(model, req) + this.maxOutput(route, model, req) > model.contextWindow
                    ? 'context window too small'
                    : undefined;
      if (reason || !model || !provider || !adapter) excluded.push({ modelId: id, reason: reason ?? 'unavailable' });
      else candidates.push({ model, provider, adapter, tier: t });
    }

    if (candidates.length === 0) {
      throw new NoCandidatesError(req.route, excluded.map((e) => `${e.modelId}: ${e.reason}`).join('; ') || `tier ${tier} has no models`);
    }
    return { route, priority, tier, ...(decision ? { decision } : {}), candidates, excluded };
  }

  async *stream(req: LlmRequest): AsyncGenerator<RouterEvent> {
    const plan = this.plan(req);
    const { route, priority } = plan;
    const background = isBackground(priority);
    const attempts: Attempt[] = [];
    const usageEventIds: string[] = [];
    let totalCost = 0;
    let attemptNo = 0;
    const requestId = uuidv7(this.o.clock.now());
    const { chars, images } = messageChars(req.messages, req.tools);

    for (const cand of plan.candidates) {
      throwIfAborted(req.signal);
      const { model, provider, adapter } = cand;

      const health = this.o.health.check(model.id, provider.id, background);
      if (!health.ok) {
        attempts.push({ attempt: 0, modelId: model.id, providerId: provider.id, outcome: 'skipped', reason: health.reason });
        continue;
      }

      const maxOutputTokens = this.maxOutput(route, model, req);
      const estIn = this.estimateInput(model, req);
      const estOut = this.o.estimator.estimateOutputTokens(model, route.id, maxOutputTokens);
      const price = this.o.prices.priceAt(model.id, this.o.clock.now());
      const estimate = this.o.estimator.estimateCost(price, estIn, estOut);

      const reservation: ReserveResult = await this.o.budget.reserve({ requestId, estimate, priority, providerId: provider.id, route: route.id });
      if (!reservation.ok) {
        // A budget denial says nothing about the model's health; free a half-open probe slot.
        this.o.health.releaseProbe(model.id);
        attempts.push({ attempt: 0, modelId: model.id, providerId: provider.id, outcome: 'skipped', reason: `budget ${reservation.budgetName}: ${reservation.action}` });
        if (reservation.action === 'downgrade') continue;
        if (reservation.action === 'defer') throw new DeferredError(`Budget "${reservation.budgetName}" is used up`, reservation.retryAt);
        if (reservation.action === 'ask') throw new BudgetApprovalNeededError(reservation.budgetName, reservation.spent, reservation.limit, reservation.retryAt);
        throw new BudgetBlockedError(reservation.budgetName, reservation.retryAt);
      }

      const adapterReq = this.adapterRequest(req, provider, maxOutputTokens);
      const retries = background ? this.o.sameModelRetries.background : this.o.sameModelRetries.interactive;
      let settled = false;

      try {
        for (let retry = 0; retry <= retries; retry++) {
          if (retry > 0) {
            // Retrying the same model needs a fresh health check (it may have opened).
            const again = this.o.health.check(model.id, provider.id, background);
            if (!again.ok) break;
          }
          attemptNo++;
          yield { type: 'attempt', attempt: attemptNo, modelId: model.id, providerId: provider.id, tier: cand.tier };

          const started = this.o.clock.now();
          let firstTokenAt: number | undefined;
          let emitted = false;
          let usage: TokenUsage | undefined;
          let finishReason: FinishReason = 'unknown';
          let providerState: unknown;
          const toolCalls: ToolCall[] = [];
          const t = provider.timeouts;
          const limits = { ...(background ? this.o.timeouts.background : this.o.timeouts.interactive), ...(t ?? {}) };
          const local = new AbortController();
          const firstTimer = setTimeout(() => local.abort(new TimeoutAbort('no first token in time')), limits.firstTokenMs);
          const totalTimer = setTimeout(() => local.abort(new TimeoutAbort('request took too long')), limits.totalMs);
          const signal = anySignal(req.signal, local.signal);

          try {
            for await (const ev of adapter.stream(model, adapterReq, signal)) {
              if (ev.type === 'rate-limit') {
                this.o.health.recordRateLimit(provider.id, ev.info);
                continue;
              }
              if (ev.type === 'finish') {
                usage = ev.usage;
                finishReason = toolCalls.length > 0 && ev.reason === 'stop' ? 'tool_calls' : ev.reason;
                providerState = ev.providerState;
                continue;
              }
              if (firstTokenAt === undefined) {
                firstTokenAt = this.o.clock.now();
                clearTimeout(firstTimer);
              }
              if (ev.type === 'text-delta' || ev.type === 'tool-call') emitted = true;
              if (ev.type === 'tool-call') toolCalls.push(ev.call);
              if (ev.type === 'tool-call') yield { type: 'tool-call', call: ev.call };
              else yield ev;
            }
            if (!usage) throw new ProviderError('server_error', 'stream ended without a finish event');

            const recorded = await this.o.ledger.record({
              providerId: provider.id,
              modelId: model.id,
              route: route.id,
              taskType: req.attribution.taskType,
              priority,
              attempt: attemptNo,
              outcome: 'ok',
              usage,
              latencyMs: this.o.clock.now() - started,
              ...(firstTokenAt !== undefined ? { ttftMs: firstTokenAt - started } : {}),
              ...this.attributionFields(req),
              estimatedInputTokens: estIn,
              estimatedCost: estimate,
            });
            usageEventIds.push(recorded.id);
            totalCost += recorded.cost;
            await this.o.budget.settle(reservation.reservationId, recorded.cost);
            settled = true;
            this.o.health.success(model.id, provider.id);
            this.o.estimator.calibrate(model, route.id, chars, images, usage.inputTokens, usage.outputTokens);
            attempts.push({ attempt: attemptNo, modelId: model.id, providerId: provider.id, outcome: 'ok', costNanoUsd: recorded.cost });
            yield {
              type: 'finish',
              modelId: model.id,
              providerId: provider.id,
              providerKind: provider.kind,
              tier: cand.tier,
              reason: finishReason,
              usage,
              costNanoUsd: totalCost,
              attempts,
              usageEventIds,
              ...(providerState !== undefined ? { providerState } : {}),
            };
            return;
          } catch (error) {
            const pe = req.signal?.aborted ? new ProviderError('cancelled', 'cancelled by caller') : classifyThrown(error, local.signal.aborted ? local.signal : undefined);
            const recorded = await this.o.ledger.record({
              providerId: provider.id,
              modelId: model.id,
              route: route.id,
              taskType: req.attribution.taskType,
              priority,
              attempt: attemptNo,
              outcome: pe.errorClass === 'cancelled' ? 'cancelled' : 'error',
              errorClass: pe.errorClass,
              usage: { inputTokens: 0, outputTokens: 0 },
              latencyMs: this.o.clock.now() - started,
              ...this.attributionFields(req),
            });
            usageEventIds.push(recorded.id);
            attempts.push({ attempt: attemptNo, modelId: model.id, providerId: provider.id, outcome: pe.errorClass === 'cancelled' ? 'cancelled' : 'error', errorClass: pe.errorClass, reason: pe.message });
            this.o.health.failure(model.id, provider.id, pe.errorClass, pe.retryAfterMs);
            this.o.logger.warn('model attempt failed', { route: route.id, model: model.id, errorClass: pe.errorClass, attempt: attemptNo });

            if (pe.errorClass === 'cancelled') throw pe;
            if (!RETRYABLE.has(pe.errorClass)) throw pe;
            if (emitted) {
              if (priority !== 'interactive') throw pe;
              yield { type: 'reset', reason: pe.errorClass };
            }
            if (NO_SAME_MODEL_RETRY.has(pe.errorClass)) break;
            if (retry < retries) await this.o.wait(backoffMs(retry), req.signal);
          } finally {
            clearTimeout(firstTimer);
            clearTimeout(totalTimer);
          }
        }
      } finally {
        if (!settled) await this.o.budget.release(reservation.reservationId);
      }
    }

    throw new AllCandidatesFailedError(req.route, attempts);
  }

  /** Collects a stream. A `reset` (mid-stream failover) discards the partial output. */
  async generate(req: LlmRequest): Promise<LlmResult> {
    let text = '';
    let toolCalls: ToolCall[] = [];
    for await (const ev of this.stream(req)) {
      if (ev.type === 'text-delta') text += ev.text;
      else if (ev.type === 'tool-call') toolCalls.push(ev.call);
      else if (ev.type === 'reset') {
        text = '';
        toolCalls = [];
      } else if (ev.type === 'finish') return { text, toolCalls, finish: ev };
    }
    throw new ProviderError('server_error', 'stream ended without finish');
  }

  /**
   * Embeddings never fail over to a different model: vectors from different models are not
   * comparable. Retries stay on the active embedding model.
   */
  async embed(req: { texts: string[]; priority: PriorityClass; attribution: LlmRequest['attribution']; modelId?: string; signal?: AbortSignal }): Promise<{ vectors: number[][]; modelId: string; costNanoUsd: number }> {
    const model = this.o.catalog.embeddingModel(req.modelId);
    if (!model) throw new NoCandidatesError('embed', 'no enabled embedding model');
    const provider = this.o.catalog.provider(model.providerId)!;
    const adapter = this.o.adapters.get(provider.id);
    if (!adapter?.embed) throw new NoCandidatesError('embed', `provider ${provider.id} cannot embed`);
    if (req.texts.length === 0) return { vectors: [], modelId: model.id, costNanoUsd: 0 };

    const estimate = this.o.estimator.estimateCost(this.o.prices.priceAt(model.id, this.o.clock.now()), Math.ceil(req.texts.join(' ').length / 4), 0);
    const reservation = await this.o.budget.reserve({ requestId: uuidv7(), estimate, priority: req.priority, providerId: provider.id, route: 'embed' });
    if (!reservation.ok) {
      if (reservation.action === 'ask' && req.priority === 'interactive') throw new BudgetApprovalNeededError(reservation.budgetName, reservation.spent, reservation.limit, reservation.retryAt);
      throw new DeferredError(`Budget "${reservation.budgetName}" is used up`, reservation.retryAt);
    }
    let settled = false;
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const started = this.o.clock.now();
        try {
          const result = await adapter.embed(model, req.texts, req.signal ?? new AbortController().signal);
          const recorded = await this.o.ledger.record({
            providerId: provider.id, modelId: model.id, route: 'embed', taskType: req.attribution.taskType, priority: req.priority,
            attempt, outcome: 'ok', usage: { inputTokens: result.inputTokens, outputTokens: 0 }, latencyMs: this.o.clock.now() - started, ...this.attributionFields(req),
          });
          await this.o.budget.settle(reservation.reservationId, recorded.cost);
          settled = true;
          return { vectors: result.vectors, modelId: model.id, costNanoUsd: recorded.cost };
        } catch (error) {
          const pe = classifyThrown(error, req.signal);
          await this.o.ledger.record({
            providerId: provider.id, modelId: model.id, route: 'embed', taskType: req.attribution.taskType, priority: req.priority,
            attempt, outcome: 'error', errorClass: pe.errorClass, usage: { inputTokens: 0, outputTokens: 0 }, ...this.attributionFields(req),
          });
          if (!RETRYABLE.has(pe.errorClass) || pe.errorClass === 'auth_error' || pe.errorClass === 'quota_exhausted' || attempt === 3) throw pe;
          await this.o.wait(pe.retryAfterMs ?? backoffMs(attempt), req.signal);
        }
      }
      throw new ProviderError('server_error', 'unreachable');
    } finally {
      if (!settled) await this.o.budget.release(reservation.reservationId);
    }
  }

  private estimateInput(model: ModelEntry, req: LlmRequest): number {
    return this.o.estimator.estimateInputTokens(model, req.messages, req.tools);
  }

  private maxOutput(route: RouteConfig, model: ModelEntry, req: LlmRequest): number {
    return Math.min(model.maxOutputTokens, req.maxOutputTokens ?? route.maxOutputTokens ?? model.maxOutputTokens);
  }

  private adapterRequest(req: LlmRequest, provider: ProviderEntry, maxOutputTokens: number): AdapterRequest {
    return {
      // Provider-specific continuation data only goes back to the provider kind that produced it.
      messages: req.messages.map((m): LlmMessage => {
        if (m.role !== 'assistant' || !m.providerState || m.providerState.providerKind === provider.kind) return m;
        const { providerState: _drop, ...rest } = m;
        return rest;
      }),
      maxOutputTokens,
      ...(req.tools?.length ? { tools: req.tools } : {}),
      ...(req.output ? { output: req.output } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.cacheBreakpoints ? { cacheBreakpoints: req.cacheBreakpoints } : {}),
      ...(req.cacheKey ? { cacheKey: req.cacheKey } : {}),
    };
  }

  private attributionFields(req: { attribution: LlmRequest['attribution'] }) {
    const a = req.attribution;
    return {
      ...(a.runId ? { runId: a.runId } : {}),
      ...(a.sessionId ? { sessionId: a.sessionId } : {}),
      ...(a.jobId ? { jobId: a.jobId } : {}),
      ...(a.promptVersion ? { promptVersion: a.promptVersion } : {}),
    };
  }
}

export type { ErrorClass };
