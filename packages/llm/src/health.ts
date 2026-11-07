import { type Clock, MINUTE, systemClock } from '@feroxes/shared';
import type { ErrorClass, RateLimitInfo } from './types.ts';

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface ModelHealth {
  modelId: string;
  state: BreakerState;
  cooldownUntil: number;
  consecutiveFailures: number;
  openCount: number;
  lastErrorClass?: ErrorClass;
  lastErrorAt?: number;
  recent: { ts: number; ok: boolean }[];
  probeInFlight: boolean;
}

export interface ProviderHealth {
  providerId: string;
  disabledUntil?: number; // quota or auth failure
  disabledReason?: ErrorClass;
  rateLimit?: RateLimitInfo & { observedAt: number };
}

export interface HealthOptions {
  clock?: Clock;
  consecutiveFailuresToOpen?: number;
  errorRateToOpen?: number;
  minCallsForErrorRate?: number;
  windowMs?: number;
  baseCooldownMs?: number;
  maxCooldownMs?: number;
  /** How long a provider stays disabled after quota/auth failures when no reset time is known. */
  disableMs?: number;
  /** Background traffic yields when remaining capacity falls below this share. */
  headroomShare?: number;
}

export interface HealthChange {
  modelId: string;
  providerId: string;
  state: BreakerState;
  cooldownUntil: number;
  reason?: ErrorClass;
}

/**
 * Circuit breakers per model, plus provider-level disables and rate-limit headroom
 * (Phase 1 plan §7.2). In-memory state; mirrored to `provider_health` for the dashboard.
 */
export class HealthTracker {
  private readonly models = new Map<string, ModelHealth>();
  private readonly providers = new Map<string, ProviderHealth>();
  private readonly o: Required<HealthOptions>;
  private readonly listeners = new Set<(c: HealthChange) => void>();

  constructor(options: HealthOptions = {}) {
    this.o = {
      clock: systemClock,
      consecutiveFailuresToOpen: 5,
      errorRateToOpen: 0.5,
      minCallsForErrorRate: 10,
      windowMs: MINUTE,
      baseCooldownMs: 30_000,
      maxCooldownMs: 10 * MINUTE,
      disableMs: 60 * MINUTE,
      headroomShare: 0.15,
      ...options,
    };
  }

  onChange(listener: (c: HealthChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private model(modelId: string): ModelHealth {
    let h = this.models.get(modelId);
    if (!h) {
      h = { modelId, state: 'closed', cooldownUntil: 0, consecutiveFailures: 0, openCount: 0, recent: [], probeInFlight: false };
      this.models.set(modelId, h);
    }
    return h;
  }

  private provider(providerId: string): ProviderHealth {
    let p = this.providers.get(providerId);
    if (!p) {
      p = { providerId };
      this.providers.set(providerId, p);
    }
    return p;
  }

  /**
   * Whether a request may be sent now. Background requests also respect rate-limit headroom.
   * A model whose cooldown passed lets exactly one probe through (half-open).
   */
  check(modelId: string, providerId: string, background: boolean): { ok: true } | { ok: false; reason: string; until: number } {
    const now = this.o.clock.now();
    const p = this.provider(providerId);
    if (p.disabledUntil && now < p.disabledUntil) {
      return { ok: false, reason: `provider disabled (${p.disabledReason})`, until: p.disabledUntil };
    }
    if (background && p.rateLimit && this.lowHeadroom(p.rateLimit, now)) {
      return { ok: false, reason: 'rate-limit headroom reserved for interactive use', until: p.rateLimit.resetAt ?? now + MINUTE };
    }
    const h = this.model(modelId);
    if (h.state === 'open') {
      if (now < h.cooldownUntil) return { ok: false, reason: `circuit open (${h.lastErrorClass})`, until: h.cooldownUntil };
      h.state = 'half_open';
      h.probeInFlight = false;
      this.emit(h, providerId);
    }
    if (h.state === 'half_open') {
      if (h.probeInFlight) return { ok: false, reason: 'circuit half-open: probe in flight', until: now + 1000 };
      h.probeInFlight = true;
    }
    return { ok: true };
  }

  private lowHeadroom(r: RateLimitInfo & { observedAt: number }, now: number): boolean {
    if (r.resetAt !== undefined && now >= r.resetAt) return false;
    const low = (remaining?: number, limit?: number) => remaining !== undefined && limit !== undefined && limit > 0 && remaining / limit < this.o.headroomShare;
    return low(r.requestsRemaining, r.requestsLimit) || low(r.tokensRemaining, r.tokensLimit);
  }

  /** Frees a half-open probe slot when the request was dropped before reaching the model. */
  releaseProbe(modelId: string): void {
    this.model(modelId).probeInFlight = false;
  }

  recordRateLimit(providerId: string, info: RateLimitInfo): void {
    this.provider(providerId).rateLimit = { ...info, observedAt: this.o.clock.now() };
  }

  success(modelId: string, providerId: string): void {
    const h = this.model(modelId);
    const now = this.o.clock.now();
    h.consecutiveFailures = 0;
    h.probeInFlight = false;
    this.pushRecent(h, now, true);
    if (h.state !== 'closed') {
      h.state = 'closed';
      h.openCount = 0;
      this.emit(h, providerId);
    }
  }

  failure(modelId: string, providerId: string, errorClass: ErrorClass, retryAfterMs?: number): void {
    const now = this.o.clock.now();
    if (errorClass === 'cancelled' || errorClass === 'invalid_request' || errorClass === 'content_filtered' || errorClass === 'context_too_long') {
      // Not the provider's fault: don't count toward the breaker.
      const h = this.model(modelId);
      h.probeInFlight = false;
      return;
    }

    if (errorClass === 'quota_exhausted' || errorClass === 'auth_error') {
      const p = this.provider(providerId);
      p.disabledUntil = now + Math.max(retryAfterMs ?? 0, this.o.disableMs);
      p.disabledReason = errorClass;
      this.listeners.forEach((l) => l({ modelId, providerId, state: 'open', cooldownUntil: p.disabledUntil!, reason: errorClass }));
      return;
    }

    const h = this.model(modelId);
    h.consecutiveFailures++;
    h.lastErrorClass = errorClass;
    h.lastErrorAt = now;
    h.probeInFlight = false;
    this.pushRecent(h, now, false);

    const recent = h.recent.filter((r) => r.ts >= now - this.o.windowMs);
    const failures = recent.filter((r) => !r.ok).length;
    const rateTrip = recent.length >= this.o.minCallsForErrorRate && failures / recent.length >= this.o.errorRateToOpen;
    // A 429 always pauses the model: sending more requests only extends the limit.
    const shouldOpen =
      h.state === 'half_open' || h.consecutiveFailures >= this.o.consecutiveFailuresToOpen || rateTrip || errorClass === 'rate_limited';

    if (shouldOpen) {
      const backoff = Math.min(this.o.maxCooldownMs, this.o.baseCooldownMs * 2 ** h.openCount);
      // A rate limit with retry-after cools down exactly that long (or the breaker backoff if longer
      // after repeated trips); a bare 429 uses the base cooldown.
      const cooldown = errorClass === 'rate_limited' ? Math.max(retryAfterMs ?? this.o.baseCooldownMs, h.openCount > 0 ? backoff : 0) : Math.max(backoff, retryAfterMs ?? 0);
      h.state = 'open';
      h.cooldownUntil = now + cooldown;
      h.openCount++;
      this.emit(h, providerId);
    }
  }

  /** Owner action ("I topped up my credits"): re-enable a provider immediately. */
  resetProvider(providerId: string): void {
    const p = this.provider(providerId);
    delete p.disabledUntil;
    delete p.disabledReason;
  }

  snapshot(): { models: ModelHealth[]; providers: ProviderHealth[] } {
    return { models: [...this.models.values()].map((m) => ({ ...m, recent: [] })), providers: [...this.providers.values()].map((p) => ({ ...p })) };
  }

  private pushRecent(h: ModelHealth, ts: number, ok: boolean) {
    h.recent.push({ ts, ok });
    const cutoff = ts - this.o.windowMs;
    while (h.recent.length > 0 && h.recent[0]!.ts < cutoff) h.recent.shift();
  }

  private emit(h: ModelHealth, providerId: string) {
    const change: HealthChange = { modelId: h.modelId, providerId, state: h.state, cooldownUntil: h.cooldownUntil, ...(h.lastErrorClass ? { reason: h.lastErrorClass } : {}) };
    for (const l of this.listeners) l(change);
  }
}
