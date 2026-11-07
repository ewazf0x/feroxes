import { FeroxesError } from '@feroxes/shared';
import type { Attempt, ErrorClass } from './types.ts';

/** An error from a provider, already classified. Adapters throw only this. */
export class ProviderError extends FeroxesError {
  readonly errorClass: ErrorClass;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(errorClass: ErrorClass, message: string, opts: { status?: number; retryAfterMs?: number; cause?: unknown } = {}) {
    super(`provider_${errorClass}`, message, { status: opts.status, retryAfterMs: opts.retryAfterMs }, { cause: opts.cause });
    this.name = 'ProviderError';
    this.errorClass = errorClass;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export class AllCandidatesFailedError extends FeroxesError {
  readonly attempts: Attempt[];
  constructor(route: string, attempts: Attempt[]) {
    super('all_candidates_failed', `No model could serve route "${route}" (${attempts.length} attempts)`, { attempts });
    this.name = 'AllCandidatesFailedError';
    this.attempts = attempts;
  }
}

export class NoCandidatesError extends FeroxesError {
  constructor(route: string, reason: string) {
    super('no_candidates', `No model is eligible for route "${route}": ${reason}`);
    this.name = 'NoCandidatesError';
  }
}

/** Background work hit a budget: the scheduler reschedules it for `retryAt`. */
export class DeferredError extends FeroxesError {
  readonly retryAt: number;
  constructor(reason: string, retryAt: number) {
    super('deferred', reason, { retryAt });
    this.name = 'DeferredError';
    this.retryAt = retryAt;
  }
}

/** Interactive work hit a budget: the chat asks the owner to continue, downgrade, or stop. */
export class BudgetApprovalNeededError extends FeroxesError {
  readonly budgetName: string;
  readonly spentNanoUsd: number;
  readonly limitNanoUsd: number;
  readonly retryAt: number;

  constructor(budgetName: string, spentNanoUsd: number, limitNanoUsd: number, retryAt: number) {
    super('budget_approval_needed', `Budget "${budgetName}" is used up; owner approval is needed to continue`, { budgetName, spentNanoUsd, limitNanoUsd, retryAt });
    this.name = 'BudgetApprovalNeededError';
    this.budgetName = budgetName;
    this.spentNanoUsd = spentNanoUsd;
    this.limitNanoUsd = limitNanoUsd;
    this.retryAt = retryAt;
  }
}

export class BudgetBlockedError extends FeroxesError {
  readonly budgetName: string;
  readonly retryAt: number;

  constructor(budgetName: string, retryAt: number) {
    super('budget_blocked', `Budget "${budgetName}" is used up`, { budgetName, retryAt });
    this.name = 'BudgetBlockedError';
    this.budgetName = budgetName;
    this.retryAt = retryAt;
  }
}

/** Parses `retry-after` (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Parses durations like "1s", "6m0s", "250ms", "1h2m" (OpenAI reset headers). */
export function parseDuration(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  let total = 0;
  let matched = false;
  for (const m of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : n * 3_600_000;
  }
  return matched ? Math.round(total) : undefined;
}

/**
 * Shared HTTP error classification. Adapters add provider-specific hints
 * (error codes and messages) through `body`.
 */
export function classifyHttp(status: number, body: string, headers: Headers): ProviderError {
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'));
  const text = body.slice(0, 2000);
  const lower = text.toLowerCase();
  const opts = { status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };

  if (/insufficient_quota|credit balance is too low|exceeded your current quota|billing|payment required|out of credits|requires more credits/.test(lower) || status === 402) {
    return new ProviderError('quota_exhausted', `Quota or credits exhausted (HTTP ${status}): ${text}`, opts);
  }
  if (/context_length_exceeded|prompt is too long|maximum context length|too many tokens|input is too long|exceeds the context window|reduce the length/.test(lower)) {
    return new ProviderError('context_too_long', `Context too long (HTTP ${status}): ${text}`, opts);
  }
  if (status === 401 || status === 403) return new ProviderError('auth_error', `Authentication failed (HTTP ${status}): ${text}`, opts);
  if (status === 429) return new ProviderError('rate_limited', `Rate limited (HTTP 429): ${text}`, opts);
  if (status === 529 || status === 503 || /overloaded/.test(lower)) return new ProviderError('overloaded', `Provider overloaded (HTTP ${status}): ${text}`, opts);
  if (status === 408 || status === 504) return new ProviderError('timeout', `Provider timeout (HTTP ${status}): ${text}`, opts);
  if (status >= 500) return new ProviderError('server_error', `Provider error (HTTP ${status}): ${text}`, opts);
  if (/content[_ ]filter|safety|blocked|moderation/.test(lower)) return new ProviderError('content_filtered', `Content filtered (HTTP ${status}): ${text}`, opts);
  return new ProviderError('invalid_request', `Invalid request (HTTP ${status}): ${text}`, opts);
}

/** Classifies non-HTTP failures (network errors, timeouts, aborts). */
export function classifyThrown(error: unknown, signal?: AbortSignal): ProviderError {
  if (error instanceof ProviderError) return error;
  const e = error as { name?: string; message?: string; code?: string; cause?: { code?: string } };
  if (signal?.aborted) {
    const reason = signal.reason as { name?: string } | undefined;
    if (reason?.name === 'TimeoutError') return new ProviderError('timeout', 'Request timed out', { cause: error });
    return new ProviderError('cancelled', 'Request cancelled', { cause: error });
  }
  if (e?.name === 'TimeoutError') return new ProviderError('timeout', 'Request timed out', { cause: error });
  if (e?.name === 'AbortError') return new ProviderError('cancelled', 'Request cancelled', { cause: error });
  return new ProviderError('network', `Network error: ${e?.message ?? String(error)}${e?.cause?.code ? ` (${e.cause.code})` : ''}`, { cause: error });
}
