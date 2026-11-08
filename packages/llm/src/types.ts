import type { PriorityClass, Sensitivity, Tier } from '@feroxes/shared';
import type { TokenUsage } from '@feroxes/metering';

// ---------- Messages (provider-neutral) ----------

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; dataBase64: string };

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | {
      role: 'assistant';
      content: string;
      toolCalls?: ToolCall[];
      /**
       * Opaque provider data needed to continue a conversation with the same provider
       * (signed thinking blocks, thought signatures). Dropped when a run switches provider.
       */
      providerState?: { providerKind: ProviderKind; data: unknown };
    }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string; isError?: boolean };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12) for the arguments, usually generated from Zod. */
  parameters: Record<string, unknown>;
}

// ---------- Catalog ----------

export type ProviderKind = 'openai' | 'anthropic' | 'google' | 'openai-compatible' | 'kiro' | 'mock';

export type Capability = 'tools' | 'vision' | 'json_schema' | 'streaming' | 'reasoning' | 'prompt_cache' | 'computer_use';

export interface ProviderEntry {
  id: string; // 'anthropic', 'openrouter', 'ollama-pc'
  kind: ProviderKind;
  name: string;
  baseUrl?: string;
  enabled: boolean;
  /** Highest data sensitivity this provider may receive (architecture §7.7). */
  maxSensitivity: Sensitivity;
  timeouts?: { firstTokenMs?: number; totalMs?: number };
  headers?: Record<string, string>;
  /** Provider-specific settings, e.g. Kiro CLI: { command, extraArgs, cwd }. */
  settings?: Record<string, unknown>;
}

export interface ModelEntry {
  id: string; // catalog id, e.g. 'anthropic/claude-sonnet-5.5'
  providerId: string;
  modelKey: string; // the provider's own model id
  displayName: string;
  modality: 'chat' | 'embedding';
  capabilities: Capability[];
  contextWindow: number;
  maxOutputTokens: number;
  tier: Tier;
  enabled: boolean;
  /** Embedding models only. */
  dimensions?: number;
}

export interface RouteConfig {
  id: string; // 'chat.turn'
  tier: Tier | 'auto';
  requiredCapabilities: Capability[];
  defaultPriority: PriorityClass;
  maxOutputTokens?: number;
  allowEscalation: boolean;
  /** Explicit candidate list that replaces the tier list. */
  candidates?: string[];
}

// ---------- Requests and events ----------

export interface Attribution {
  taskType: string;
  promptVersion?: string;
  runId?: string;
  sessionId?: string;
  jobId?: string;
}

export interface LlmRequest {
  route: string;
  priority?: PriorityClass;
  tier?: Tier | 'auto';
  /** Upper bound on tier, e.g. from economy mode admission. */
  tierCap?: Tier;
  messages: LlmMessage[];
  tools?: ToolSpec[];
  output?: { name: string; schema: Record<string, unknown> };
  maxOutputTokens?: number;
  temperature?: number;
  sensitivity: Sensitivity;
  /** Indexes of messages after which a provider cache breakpoint is placed. */
  cacheBreakpoints?: number[];
  /** Stable key for providers with automatic prefix caching (OpenAI). */
  cacheKey?: string;
  attribution: Attribution;
  signal?: AbortSignal;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'unknown';

export type ErrorClass =
  | 'rate_limited'
  | 'overloaded'
  | 'server_error'
  | 'timeout'
  | 'network'
  | 'quota_exhausted'
  | 'auth_error'
  | 'context_too_long'
  | 'invalid_request'
  | 'content_filtered'
  | 'cancelled';

export const RETRYABLE: ReadonlySet<ErrorClass> = new Set(['rate_limited', 'overloaded', 'server_error', 'timeout', 'network', 'quota_exhausted', 'auth_error', 'context_too_long']);

/** Errors after which the same model is not retried within one request. */
export const NO_SAME_MODEL_RETRY: ReadonlySet<ErrorClass> = new Set(['rate_limited', 'quota_exhausted', 'auth_error', 'context_too_long']);

export interface RateLimitInfo {
  requestsRemaining?: number;
  requestsLimit?: number;
  tokensRemaining?: number;
  tokensLimit?: number;
  resetAt?: number;
}

/** What adapters yield. The router turns these into RouterEvents. */
export type AdapterEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'rate-limit'; info: RateLimitInfo }
  | { type: 'finish'; reason: FinishReason; usage: TokenUsage; providerState?: unknown; providerRequestId?: string };

export interface AdapterRequest {
  messages: LlmMessage[];
  tools?: ToolSpec[];
  output?: { name: string; schema: Record<string, unknown> };
  maxOutputTokens: number;
  temperature?: number;
  cacheBreakpoints?: number[];
  cacheKey?: string;
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  stream(model: ModelEntry, req: AdapterRequest, signal: AbortSignal): AsyncIterable<AdapterEvent>;
  embed?(model: ModelEntry, texts: string[], signal: AbortSignal): Promise<{ vectors: number[][]; inputTokens: number }>;
}

export interface Attempt {
  attempt: number;
  modelId: string;
  providerId: string;
  outcome: 'ok' | 'error' | 'skipped' | 'cancelled';
  errorClass?: ErrorClass;
  reason?: string;
  costNanoUsd?: number;
}

export type RouterEvent =
  | { type: 'attempt'; attempt: number; modelId: string; providerId: string; tier: Tier }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'reset'; reason: ErrorClass }
  | {
      type: 'finish';
      modelId: string;
      providerId: string;
      providerKind: ProviderKind;
      tier: Tier;
      reason: FinishReason;
      usage: TokenUsage;
      costNanoUsd: number;
      attempts: Attempt[];
      usageEventIds: string[];
      providerState?: unknown;
    };

export interface LlmResult {
  text: string;
  toolCalls: ToolCall[];
  finish: Extract<RouterEvent, { type: 'finish' }>;
}
