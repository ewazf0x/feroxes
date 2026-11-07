# Phase 1 Implementation Plan: Foundation

> Memory · Multi-API router · Token and cost management · Basic agent
> Status: draft for review · 2026-11-07

## 1. Goal

At the end of Phase 1, Feroxes runs as a 24/7 service on one host and the owner can:

- chat with an agent that uses tools, streams answers, and cites the memories it used;
- configure three or more AI providers and watch requests fail over between them when one is rate-limited, down, or out of quota;
- see every token and dollar spent, by provider, model, task type and priority, against daily, weekly and monthly budgets that are enforced before calls happen;
- pause background work or stop everything with one button;
- browse, search, edit, pin, archive and delete memories, and watch them being consolidated over days without raw data ever being lost;
- approve or deny risky tool calls, and read a tamper-evident log of everything the agent did.

Phase 1 builds the parts every later phase depends on: the data model, the router, the ledger, the memory engine, the policy gate, the agent runtime and the event stream. Later phases add capabilities (voice, connectors, devices) on top without changing these foundations.

## 2. Scope

### In scope
1. Monorepo, tooling, CI, Docker Compose, config and secret vault, owner authentication, CLI.
2. Database schema and migrations for everything listed in §5.
3. Intelligence layer: adapters for OpenAI, Anthropic, Google, any OpenAI-compatible endpoint (including Ollama, OpenRouter, Groq, DeepSeek), and a scripted mock provider; model catalog with prices; tiers and routes; health tracking, circuit breakers, failover; complexity classifier; embeddings with cache.
4. Metering: ledger, pricing, estimation and calibration, budgets with reservations, thresholds and alerts, power modes, admission control for background jobs, usage APIs.
5. Policy and tools: tool SDK, registry, Tool Runtime as the single gate, permission matrix and autonomy presets, approvals, taint tracking, kill switch, hash-chained audit log.
6. Agent runtime: runs and steps, streaming loop, context builder with prompt-cache layout, cancellation, approval wait and resume, crash recovery.
7. Memory engine: working memory with rolling summaries, extraction and reconciliation, explicit remember and forget, hybrid retrieval, consolidation jobs, core block, history and undo, suppression rules, JSONL export, encrypted backups.
8. Built-in tools: `memory.*`, `time.now`, `web.search` (pluggable search provider, optional), `web.fetch` (SSRF-safe, taints the run), `files.*` (sandboxed workspace directory on the Core host), `plan.update` (the run's own checklist), `notify.owner`.
9. API: REST plus an SSE event stream with catch-up.
10. Web UI, minimal but complete enough to operate and inspect everything above: setup wizard, login, chat, dashboard, memory browser, usage and budgets, activity and audit, approvals, settings (providers, routing, budgets, permissions, memory, system). Responsive and installable.
11. Feedback capture: thumbs up/down and corrections stored and fed into memory extraction and routing statistics.

### Out of scope (later phases)
Voice, web push, passkeys and step-up auth, MCP client, conditional permission rules, batch APIs (Phase 2) · connectors, proactive monitors, briefings (Phase 3) · device agents, browser automation (Phase 4) · planner and sub-agents, web learning, wake word (Phase 5).

**Scope decision worth flagging:** the UI requirement belongs to the whole project, but Phase 1 includes a working UI subset because there is no other good way to verify memory, routing and budgets. Visual polish and the full dashboard are Phase 2.

## 3. Milestones

| ID | Milestone | Depends on | Size | Outcome |
|---|---|---|---|---|
| M0 | Platform skeleton | | M | Repo builds, lints and tests in CI; Compose brings up Postgres; Core boots, migrates, serves `/healthz`; owner setup and login work |
| M1 | Data model | M0 | M | All Phase 1 tables and migrations; append-only and audit triggers; repository test harness |
| M2 | Intelligence layer | M1 | L | Four adapter kinds + mock; catalog; router with tiers, routes, health, circuit breaker, failover; chaos tests green |
| M3 | Metering | M2 | M | Ledger on every call; budgets with reservations; thresholds, alerts, power modes, admission; usage queries |
| M4 | Policy and tools | M1 | M | Tool SDK, Tool Runtime gate, permission matrix, approvals, taint, kill switch, audit chain + verifier; built-in tools |
| M5 | Agent runtime | M2, M3, M4 | L | Streaming tool-using runs with persistence, cancellation, approval wait/resume, crash recovery |
| M6 | Memory engine | M2, M3, M5 | L | Extraction, reconciliation, retrieval, context integration, consolidation jobs, owner operations, export and backup |
| M7 | API, events, web UI | M5 (contracts), M6 | L | REST + SSE complete; all Phase 1 screens working on desktop and phone |
| M8 | Hardening and acceptance | all | M | Eval baseline, 24-hour soak test, backup/restore drill, acceptance criteria in §11 met |

Sizes: S ≈ 1–2 focused days, M ≈ 3–5, L ≈ 1–2 weeks. Total is roughly 6 to 8 focused engineer-weeks. M2–M3 and M4 can proceed in parallel, and UI work in M7 can start once M5 has fixed the API contracts.

## 4. Milestone details

### M0: Platform skeleton
- pnpm workspace, Turborepo pipeline (`build`, `typecheck`, `lint`, `test`), TS 7 project references, Oxlint (type-aware, with `no-floating-promises` and `no-misused-promises` on: unhandled promise rejections kill long-running daemons) and Oxfmt.
- `packages/shared`: ids, `Result`, error classes, clock (injectable for tests), logger and event-bus interfaces.
- `apps/core`: Zod-validated config, pino logger with redaction, Fastify server, `/healthz` and `/readyz`, graceful shutdown, migration runner under a Postgres advisory lock, single-Core lease at boot, `ROLE` switch.
- Vault: AES-256-GCM encrypt/decrypt with key versioning; master key loaded from a Docker secret or env.
- Owner setup and login: first-run setup endpoint (only works while no owner exists), argon2id password, optional TOTP, session cookies, host allowlist, CSRF header check, login rate limit.
- CLI skeleton: `feroxes migrate`, `feroxes owner:reset-password`.
- `infra/compose.dev.yaml` (Postgres with pgvector) and CI workflow.

**Done when:** a clean clone runs `pnpm i && pnpm dev`, the Core migrates an empty database and serves `/healthz`, and the setup → login → `/api/auth/me` flow works in an integration test.

### M1: Data model
- Drizzle schema for every table in §5, generated SQL migrations reviewed by hand.
- Triggers: `audit_log` rejects `UPDATE` and `DELETE`; `messages` rejects `UPDATE` of content and `DELETE` except through the owner-delete function, which records a tombstone.
- Generated `tsvector` column on `memories`; `pg_trgm` indexes on entity names and aliases.
- Embedding spaces: untyped `vector` column with one partial HNSW expression index per active space (see §5.4).
- Test harness: Testcontainers Postgres (`pgvector/pgvector:pg18`), per-test schema reset, factories.

**Done when:** migrations apply from zero and are idempotent; trigger tests prove append-only rules; a vector search uses the partial index (checked with `EXPLAIN`).

### M2: Intelligence layer
- `ProviderAdapter` implementations on top of AI SDK 6 provider packages: `openai`, `anthropic`, `google`, `openai-compatible`. Each maps vendor errors to Feroxes error classes and extracts `retry-after` and rate-limit headers.
- `mock` provider: scripted per test (text, tool calls, delays, 429, 5xx, timeouts, mid-stream failure, usage numbers).
- Model catalog seeded from `config/models.catalog.yaml`; `listModels` sync for providers that support it; owner edits in Settings.
- Tiers and routes from `config/routing.default.yaml` (see §9.2).
- Router: candidate planning (§7.1), attempt loop and failover (§7.2), health and circuit breakers (persisted to `provider_health` for the dashboard and restarts), stream `reset` semantics, rate-limit headroom.
- Complexity classifier for `tier: auto` (§7.6).
- Embedding service: batching, cache keyed by `(space, sha256(text))`, routing to the active embedding space.
- Provider test endpoint: a tiny request that verifies key, model access and streaming.

**Done when:** contract tests pass for every adapter (recorded fixtures plus an opt-in live smoke test), and chaos tests show correct failover for each error class in §7.2.

### M3: Metering
- Ledger writes for every attempt, including failures and cancellations (partial usage when the provider reports it).
- Prices with effective dates; cost computation with cached-input, cache-write and context-length tiers.
- Estimator with tokenizer for OpenAI-family models and calibrated ratios for others (§7.3).
- Budgets, counters and reservations (§7.4), sweeper for expired reservations, threshold alerts, spend-rate anomaly detection.
- Power modes and the admission API used by the scheduler (§7.5).
- Rollups (`usage_daily`) every 5 minutes for fast dashboards.

**Done when:** a concurrency test with 20 parallel background jobs against a small budget never overshoots by more than the in-flight reservations, and ledger totals match hand-computed costs to the cent.

### M4: Policy and tools
- `defineTool`, registry, toolsets.
- Tool Runtime `invoke()`: system-state check → policy decision → approval request or execution → audit write. Idempotency keys; output shaping (truncate to 2k tokens, store the full output as an artifact).
- Permission matrix from `config/policy.default.yaml`; autonomy presets; per-tool overrides; the hard floor.
- Taint set on runs; escalation rules (§7.11).
- System state: `running` or `stopped`, persisted, with STOP semantics (§7.12). Pausing background work is a power mode (§7.5), not a system state.
- Audit hash chain and `feroxes audit:verify` (§7.13).
- Built-in tools listed in §2. `web.fetch` blocks private, loopback, link-local and `100.64.0.0/10` (tailnet) ranges and pins DNS; `files.*` is confined to `FEROXES_WORKSPACE_DIR` with symlink-safe path checks.

**Done when:** every built-in tool has policy tests (allow, notify, ask, deny); STOP denies every call; tampering with any audit row fails verification.

### M5: Agent runtime
- Runs, steps and tool calls persisted (§5.2); state machine as in the architecture doc.
- Loop: context → router stream → tool calls through the Tool Runtime → repeat; parallel read-only calls, sequential side effects.
- Limits: steps (interactive 12, background 6), cost per run (interactive $0.50 then ask to continue, background $0.10 hard), wall time, loop detection (same tool and arguments three times stops the run).
- Context Builder with the six-layer layout and cache breakpoints (§7.7); compaction into the rolling session summary.
- Cancellation through AbortSignal, from the UI, from STOP, and from limits.
- Approval wait: the run persists and releases its worker; resolution re-enqueues it.
- Crash recovery at boot (§7.12).
- Events published for every state change; ephemeral text deltas; snapshots for reconnecting clients.

**Done when:** a scripted multi-step run with tools, an approval and a Core restart in the middle completes with each side-effecting call executed exactly once.

### M6: Memory engine
- Store, embeddings, history (`memory_events`), sources, links, entities, suppression rules (§5.3).
- Extraction job, debounced per session; immediate path for "remember …" (§7.8).
- Reconciliation with fixed rules on top of model decisions (§7.8).
- Hybrid retrieval and packing (§7.9); `buildContext` used by the Context Builder; memory ids attached to answers for citation.
- Consolidation jobs (§7.10): session-idle episodes, nightly digest and dedupe and decay and core block, weekly and monthly roll-ups, nightly integrity check.
- Owner operations: edit (new version), pin, sensitivity, archive, restore, delete permanently with optional suppression, undo through events.
- Embedding space switch: create the new space, re-embed in the background under a budget, flip retrieval when complete, retire the old index.
- JSONL export; nightly encrypted `pg_dump` (§9.1); `feroxes backup:verify`.

**Done when:** the memory scenarios in §11 pass and the retrieval eval meets its baseline.

### M7: API, events and web UI
- REST endpoints in §8, Zod-validated, typed client generated for the web app from `@feroxes/protocol`.
- SSE: topics, `Last-Event-ID` catch-up from `event_log`, snapshots of active runs, 15-second heartbeats.
- Screens:
  - **Setup wizard:** owner account → providers (with key test) → embedding model → budgets → autonomy preset.
  - **Chat:** session list; streaming markdown; tool-call cards (arguments and results, collapsible); inline approval cards (approve, deny, edit arguments); "memories used" chips with a popover; model and cost badge per answer; stop; retry on a higher tier; thumbs up/down; "remember this" on any message.
  - **Dashboard:** system state with STOP and power mode; today's spend against budgets; provider health grid; active runs; recent memories; alerts.
  - **Memory:** hybrid search with an "explain scores" toggle; filters (layer, kind, entity, status, sensitivity, source, date, confidence); detail drawer with sources (links to messages), history with diffs, links; edit, pin, archive, delete; core block tab; entities tab.
  - **Usage:** spend over time stacked by provider; breakdowns by model, route and priority; cache hit rate; failovers; top runs by cost; budgets with burn-down and projection; power mode.
  - **Activity:** runs list → run timeline (steps, model calls, tool calls, costs, timing); audit log with filters and chain status.
  - **Approvals:** pending queue.
  - **Settings:** providers, routing (drag to reorder tier lists), budgets, permissions (preset + matrix + per-tool overrides), memory (embedding space, schedules), system (timezone, backups, export), security (password, TOTP, sessions).
- PWA manifest, icons, Serwist offline shell; layouts tested at phone width.

**Done when:** Playwright end-to-end tests cover setup, chat with a tool call and an approval, memory edit and delete, budget edit, STOP and resume.

### M8: Hardening and acceptance
- Memory retrieval eval baseline and routing eval (§10).
- 24-hour soak test with the mock provider: background jobs and scripted chats around the clock.
- Backup and restore drill.
- Runbook in `docs/`: install, upgrade, backup, restore, rotate the master key, recover from STOP.

**Done when:** every acceptance criterion in §11 passes.

## 5. Data model

All ids are UUIDv7. All timestamps are `timestamptz` in UTC. Money is `numeric(14,8)` USD. Columns listed are the important ones, not every column.

### 5.1 Owner and system

| Table | Key columns | Notes |
|---|---|---|
| `owner` | `id`, `display_name`, `password_hash`, `totp_secret_enc`, `timezone`, `locale` | Exactly one row, enforced by a check constraint |
| `auth_sessions` | `id`, `token_hash`, `created_at`, `expires_at`, `last_seen_at`, `user_agent`, `revoked_at` | Only the hash of the cookie token is stored |
| `vault_secrets` | `id`, `kind` (`provider_key`, `oauth_token`, `search_key`, ...), `ref`, `ciphertext`, `nonce`, `key_version`, `rotated_at` | AES-256-GCM |
| `system_state` | `id = 1`, `state` (`running`, `stopped`), `power_mode` (`normal`, `economy`, `background_paused`), `changed_by`, `reason`, `changed_at`, `lease_holder`, `lease_expires_at` | Read at boot; the Core starts in the persisted state. The lease allows one Core per database (architecture §4.1) |
| `settings` | `key`, `value jsonb`, `updated_at` | Typed via Zod per key |

### 5.2 Conversations and agent (working memory and raw log)

| Table | Key columns | Notes |
|---|---|---|
| `sessions` | `id`, `channel` (`web`, `voice`, `system`), `title`, `status` (`active`, `idle`, `closed`), `rolling_summary`, `summary_through_seq`, `last_activity_at` | |
| `messages` | `id`, `session_id`, `seq`, `role` (`user`, `assistant`, `tool`, `system`), `parts jsonb` (text, image refs, tool calls, tool results), `run_id`, `token_estimate`, `rendered_context jsonb`, `created_at` | Append-only. `rendered_context` keeps the exact memory block sent with a user turn, so later prompts stay byte-identical for caching (§7.7) |
| `feedback` | `id`, `target_type` (`message`, `memory`, `run`), `target_id`, `kind` (`thumb_up`, `thumb_down`, `correction`, `note`), `content`, `created_at` | Feeds extraction and routing statistics |
| `agent_runs` | `id`, `session_id`, `trigger` (`user_message`, `schedule`, `event`, `subrun`), `parent_run_id`, `priority`, `status`, `goal`, `tier`, `limits jsonb`, `totals jsonb` (steps, tokens, cost), `taint jsonb`, `error`, `resume_count`, timestamps | State machine in architecture §5.2 |
| `agent_steps` | `id`, `run_id`, `idx`, `kind` (`model`, `tool`, `approval`, `note`), `status`, `input jsonb`, `output jsonb`, `usage_event_id`, `started_at`, `finished_at` | Written before the next step starts |
| `tool_calls` | `id`, `run_id`, `step_id`, `tool`, `args jsonb` (redacted copy), `idempotency_key` (unique), `status` (`pending`, `awaiting_approval`, `running`, `succeeded`, `failed`, `denied`, `cancelled`), `result_summary`, `artifact_id`, `error`, timestamps | |
| `approval_requests` | `id`, `run_id`, `tool_call_id`, `category`, `summary`, `preview jsonb`, `agent_reason`, `taint jsonb`, `status` (`pending`, `approved`, `denied`, `expired`), `edited_args jsonb`, `decided_at`, `expires_at` | |
| `artifacts` | `id`, `run_id`, `kind`, `mime`, `size`, `storage_ref`, `sha256`, `created_at` | Large tool outputs; small ones inline, big ones on disk |

### 5.3 Memory

| Table | Key columns | Notes |
|---|---|---|
| `memories` | `id`, `layer` (`episodic`, `semantic`, `procedural`), `kind`, `title`, `content`, `structured jsonb`, `importance` (0–1), `confidence` (0–1), `evidence_count`, `sensitivity` (`normal`, `private`, `secret`), `status` (`active`, `superseded`, `merged`, `archived`), `pinned`, `source` (`owner_asserted`, `extracted`, `consolidated`, `imported`), `occurred_at`, `valid_from`, `valid_to`, `supersedes_id`, `merged_into_id`, `content_hash`, `fts tsvector` (generated), `version`, `access_count`, `last_accessed_at`, timestamps | One table for all long-term layers |
| `memory_events` | `id`, `memory_id`, `type` (`created`, `updated`, `superseded`, `merged`, `archived`, `restored`, `pinned`, `deleted`), `actor` (`owner`, `agent`, `extractor`, `consolidator`), `before jsonb`, `after jsonb`, `reason`, `run_id`, `created_at` | Full history; undo replays `before` |
| `memory_sources` | `memory_id`, `source_type` (`message`, `session`, `run`, `tool_call`, `web`, `import`), `source_id`, `excerpt` | Provenance shown in the UI |
| `memory_links` | `from_id`, `to_id`, `type` (`derived_from`, `part_of`, `contradicts`, `supports`, `related`), `weight` | Digest hierarchy, contradictions, evidence |
| `entities` | `id`, `kind` (`person`, `org`, `project`, `place`, `account`, `topic`, `thing`), `name`, `aliases text[]`, `summary`, `attributes jsonb`, `importance` | `pg_trgm` indexes on `name` and `aliases` |
| `memory_entities` | `memory_id`, `entity_id`, `role` (`subject`, `object`, `mentioned`) | |
| `relations` | `id`, `from_entity`, `to_entity`, `type` (`sister_of`, `works_at`, ...), `evidence_memory_id`, `valid_from`, `valid_to`, `confidence` | Populated by extraction; graph UI in Phase 2 |
| `memory_suppressions` | `id`, `content_hash`, `space_id`, `embedding vector`, `pattern`, `reason`, `created_at` | Blocks re-learning of deleted facts |
| `core_memory_snapshots` | `id`, `content`, `token_count`, `source_memory_ids uuid[]`, `generated_at` | Latest one goes into every prompt |
| `core_memory_notes` | `id`, `content`, `updated_at` | Owner's free-form notes, never regenerated |
| `memory_embeddings` | `memory_id`, `space_id`, `embedding vector`, `content_hash`, `created_at` | PK `(memory_id, space_id)`; see §5.4 |
| `embedding_spaces` | `id`, `model_id`, `dims`, `status` (`building`, `active`, `retired`), `created_at` | Exactly one `active` |
| `embedding_cache` | `space_id`, `content_hash`, `embedding vector`, `created_at` | Avoids paying twice for the same text |

Deleting a memory permanently removes its row, embeddings, sources and links, and replaces its `memory_events` payloads with a tombstone (`deleted`, no content). Derived memories built only from it are deleted with it. Derived memories built from several sources are regenerated without it by the next consolidation.

### 5.4 Embedding spaces and indexes

The `embedding` column is declared without a fixed dimension, so vectors from different models can live in one table. Each active space gets its own partial expression index, the pattern pgvector documents for mixed dimensions:

```sql
CREATE INDEX memory_embeddings_space_<id>_hnsw
  ON memory_embeddings
  USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
  WHERE space_id = '<id>';
```

Queries use the same cast and `WHERE space_id = …`, so the planner picks that index. Switching models never mixes incomparable vectors, and the old space keeps serving retrieval until the new one is fully built.

### 5.5 Intelligence and metering

| Table | Key columns | Notes |
|---|---|---|
| `providers` | `id`, `kind`, `name`, `base_url`, `secret_id`, `enabled`, `max_sensitivity`, `settings jsonb` (headers, org, timeouts) | |
| `models` | `id`, `provider_id`, `model_key`, `display_name`, `modality` (`chat`, `embedding`, `tts`, `stt`), `capabilities jsonb`, `context_window`, `max_output_tokens`, `tier`, `latency_class`, `enabled` | |
| `model_prices` | `id`, `model_id`, `effective_from`, `effective_to`, `input_per_mtok`, `output_per_mtok`, `cached_input_per_mtok`, `cache_write_per_mtok`, `unit_price` (per character or second), `context_tiers jsonb`, `batch_discount`, `source_url` | Never updated in place; new rows for new prices |
| `tiers` | `name`, `candidates uuid[]` (ordered model ids) | Owner reorders in Settings |
| `routes` | `id` (`chat.turn`, ...), `tier_policy` (`auto` or a tier), `required_capabilities text[]`, `default_priority`, `max_output_tokens`, `input_token_target`, `allow_escalation`, `overrides jsonb` | |
| `provider_health` | `model_id`, `state` (`closed`, `open`, `half_open`), `cooldown_until`, `consecutive_failures`, `last_error_class`, `last_error_at`, `rate_limit jsonb` (latest header values) | Mirrors in-memory state |
| `usage_events` | `id`, `ts`, `provider_id`, `model_id`, `price_id`, `route`, `task_type`, `priority`, `run_id`, `session_id`, `job_id`, `attempt`, `outcome` (`ok`, `error`, `cancelled`), `error_class`, `input_tokens`, `output_tokens`, `cached_input_tokens`, `cache_write_tokens`, `reasoning_tokens`, `units`, `cost_usd`, `latency_ms`, `ttft_ms`, `provider_request_id`, `prompt_version` | The ledger. Append-only |
| `usage_daily` | `day`, `provider_id`, `model_id`, `route`, `priority`, sums and counts | Rollup for dashboards |
| `budgets` | `id`, `name`, `scope_type` (`global`, `provider`, `route`, `priority`), `scope_value`, `period` (`day`, `week`, `month`), `limit_usd`, `limit_tokens`, `interactive_reserve_usd`, `soft_thresholds int[]`, `hard_action` (`downgrade`, `defer`, `ask`, `block`), `enabled` | |
| `budget_counters` | `budget_id`, `period_start`, `spent_usd`, `reserved_usd`, `spent_tokens` | One row per budget and period; O(1) checks |
| `budget_reservations` | `id`, `request_id`, `budget_id`, `amount_usd`, `status` (`active`, `settled`, `released`, `expired`), `created_at`, `expires_at` | |
| `budget_alerts` | `id`, `budget_id`, `period_start`, `threshold`, `fired_at`, `acknowledged_at` | One alert per threshold per period |

### 5.6 Policy, audit, events, notifications

| Table | Key columns | Notes |
|---|---|---|
| `permission_rules` | `id`, `scope` (`category`, `tool`), `target`, `level` (`allow`, `notify`, `ask`, `deny`), `created_by`, `note` | Preset values plus owner overrides |
| `audit_log` | `id bigserial`, `ts`, `actor` (`owner`, `agent`, `system`, `scheduler`), `action`, `category`, `run_id`, `tool_call_id`, `decision` (`allow`, `notify`, `ask`, `deny`, `approved`, `denied`), `outcome` (`success`, `failure`, `pending`), `summary`, `details jsonb` (redacted), `cost_usd`, `prev_hash`, `hash` | Append-only by trigger; hash chain |
| `event_log` | `seq bigserial`, `ts`, `topic`, `session_id`, `run_id`, `payload jsonb` | SSE catch-up; trimmed after 7 days |
| `notifications` | `id`, `kind`, `severity`, `title`, `body`, `link`, `created_at`, `read_at`, `channels jsonb` | In-app in Phase 1; push in Phase 2 |

## 6. Core interfaces

These are the contracts between packages. Implementation details can change; these should change rarely.

### 6.1 `@feroxes/llm`

```ts
export type PriorityClass = 'interactive' | 'important' | 'routine' | 'deferrable';
export type Tier = 'frontier' | 'balanced' | 'fast' | 'local';
export type Sensitivity = 'normal' | 'private' | 'secret';
export type Capability =
  | 'tools' | 'vision' | 'json_schema' | 'streaming'
  | 'reasoning' | 'prompt_cache' | 'computer_use';

export interface LlmRequest {
  route: RouteId;                       // 'chat.turn' | 'memory.extract' | ...
  priority: PriorityClass;
  tier?: Tier | 'auto';                 // overrides the route's tier policy
  messages: LlmMessage[];               // provider-neutral
  tools?: ToolSpec[];                   // JSON Schema generated from Zod
  output?: { name: string; schema: JsonSchema };  // structured output
  maxOutputTokens?: number;
  sensitivity: Sensitivity;             // highest label of any content in the prompt
  cacheBreakpoints?: number[];          // message indexes, set by the Context Builder
  attribution: { taskType: TaskType; promptVersion?: string;
                 runId?: string; sessionId?: string; jobId?: string };
  signal?: AbortSignal;
}

export type RouterEvent =
  | { type: 'attempt'; attempt: number; provider: string; model: string }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; callId: string; name: string; args: unknown }
  | { type: 'reset'; reason: ErrorClass }          // discard partial output, a new attempt follows
  | { type: 'finish'; model: ModelRef; usage: Usage; costUsd: number;
      finishReason: FinishReason; usageEventIds: string[] };

export interface ModelRouter {
  stream(req: LlmRequest): AsyncIterable<RouterEvent>;
  generate<T>(req: LlmRequest & { output: { name: string; schema: JsonSchema } }): Promise<LlmResult<T>>;
  embed(req: { texts: string[]; priority: PriorityClass; attribution: Attribution }): Promise<EmbedResult>;
}

export interface ProviderAdapter {
  readonly kind: 'openai' | 'anthropic' | 'google' | 'openai-compatible' | 'mock' | 'custom';
  stream(model: ModelEntry, req: AdapterRequest, signal: AbortSignal): AsyncIterable<AdapterEvent>;
  embed?(model: ModelEntry, texts: string[], signal: AbortSignal): Promise<AdapterEmbedResult>;
  listModels?(): Promise<RemoteModel[]>;
  /** Maps any vendor error to a Feroxes error class, with retry-after when known. */
  classifyError(err: unknown): { class: ErrorClass; retryAfterMs?: number; message: string };
}
```

### 6.2 `@feroxes/metering`

```ts
export interface BudgetGate {
  /** Reserve an estimate on every applicable budget, all or nothing. */
  reserve(req: {
    requestId: string; estimateUsd: number; estimateTokens: number;
    priority: PriorityClass; providerId: string; route: RouteId;
  }): Promise<
    | { ok: true; reservationId: string }
    | { ok: false; action: 'downgrade' | 'defer' | 'ask' | 'block';
        budgetId: string; retryAt?: Date }
  >;
  settle(reservationId: string, actual: { usd: number; tokens: number; usageEventId: string }): Promise<void>;
  release(reservationId: string): Promise<void>;

  /** Cheap check the scheduler runs before starting a job. Reflects power mode and budget state. */
  admit(priority: PriorityClass): Promise<{ admitted: true } | { admitted: false; retryAt: Date; reason: string }>;
}

export interface UsageLedger {
  record(event: UsageEventInput): Promise<{ id: string; costUsd: number }>;
}

export interface CostEstimator {
  estimate(model: ModelEntry, req: LlmRequest): { inputTokens: number; outputTokens: number; usd: number };
  calibrate(modelId: string, estimatedInput: number, actualInput: number): void;
}
```

### 6.3 `@feroxes/policy` and `@feroxes/tools`

```ts
export type RiskCategory =
  | 'read' | 'internal_write' | 'external_write' | 'communicate'
  | 'destructive' | 'device_control' | 'financial' | 'security';

export type PermissionLevel = 'allow' | 'notify' | 'ask' | 'deny';

export interface ToolDefinition<I extends z.ZodType = z.ZodType, O = unknown> {
  name: string;                         // 'memory.search', 'files.write'
  toolset: string;                      // 'memory', 'files', 'web', ...
  description: string;                  // written for the model
  input: I;
  risk: { category: RiskCategory; reversible: boolean; untrustedOutput?: boolean };
  /** Human-readable preview for approval cards, e.g. the email that would be sent. */
  preview?(input: z.infer<I>): ApprovalPreview;
  execute(input: z.infer<I>, ctx: ToolContext): Promise<ToolResult<O>>;
}

export interface ToolContext {
  runId: string; callId: string; idempotencyKey: string;
  signal: AbortSignal;
  taint: TaintSet;                      // tools with untrusted output add their sources
  artifacts: ArtifactStore;
  log: Logger;
  progress(message: string): void;
}

export interface PolicyEngine {
  decide(action: {
    tool: string; category: RiskCategory; args: unknown;
    runTaint: TaintSet; actor: 'agent' | 'owner' | 'scheduler';
  }): Promise<{ level: PermissionLevel; reason: string; ruleId?: string; hardFloor: boolean }>;
  systemState(): SystemState;           // 'running' | 'stopped'
}

/** The only path from anything in Feroxes to a side effect. */
export interface ToolRuntime {
  invoke(call: { runId: string; stepId: string; callId: string; tool: string; args: unknown },
         ctx: InvocationContext): Promise<
    | { status: 'executed'; result: ToolResult }
    | { status: 'awaiting_approval'; approvalId: string }
    | { status: 'denied'; reason: string }
  >;
}
```

### 6.4 `@feroxes/memory`

```ts
export interface MemoryService {
  remember(input: RememberInput, actor: Actor): Promise<Memory>;        // explicit saves
  ingestTurn(sessionId: string, messageIds: string[]): Promise<void>;    // schedules debounced extraction
  search(q: MemoryQuery): Promise<ScoredMemory[]>;                       // hybrid, with score breakdown
  get(id: string): Promise<MemoryDetail>;                                // + sources, history, links
  update(id: string, patch: MemoryPatch, actor: Actor): Promise<Memory>; // new version + event
  setPinned(id: string, pinned: boolean, actor: Actor): Promise<void>;
  archive(id: string, actor: Actor): Promise<void>;
  restore(id: string, actor: Actor): Promise<void>;
  delete(id: string, opts: { suppress: boolean }, actor: Actor): Promise<void>;
  undo(eventId: string, actor: Actor): Promise<void>;
  /** Core block + retrieved memories for one prompt, within token budgets and the provider's sensitivity limit. */
  buildContext(req: {
    sessionId: string; query: string; recentMessages: LlmMessage[];
    maxSensitivity: Sensitivity; budgets: { core: number; retrieved: number };
  }): Promise<MemoryContext>;
}
```

### 6.5 `@feroxes/agent`

```ts
export interface AgentRuntime {
  start(input: {
    trigger: RunTrigger; sessionId?: string; goal?: string;
    priority: PriorityClass; limits?: Partial<RunLimits>;
  }): Promise<{ runId: string }>;
  cancel(runId: string, reason: string): Promise<void>;
  onApprovalResolved(approvalId: string): Promise<void>;   // re-enqueues the waiting run
  recoverAfterRestart(): Promise<RecoveryReport>;
}
```

### 6.6 Events (SSE topics)

| Topic | Payload highlights | Persisted |
|---|---|---|
| `run.status` | run id, status, totals | yes |
| `run.delta` | run id, text or reasoning delta | no (snapshot on reconnect) |
| `run.reset` | run id, reason | no |
| `run.tool` | call id, tool, status, summary | yes |
| `run.approval` | approval id, preview, category, taint | yes |
| `memory.changed` | memory id, event type | yes |
| `usage.updated` | period totals | coalesced, every 5 s |
| `budget.threshold` | budget id, threshold, spend | yes |
| `provider.health` | model id, state, cooldown | yes |
| `system.state` | state, power mode, actor | yes |
| `notification.created` | notification | yes |

## 7. Algorithms and defaults

All numbers below are starting defaults, stored in settings and tunable without code changes.

### 7.1 Route resolution and candidate planning

```
plan(req):
  route = routes[req.route]
  tier  = req.tier ?? route.tier_policy
  if tier == 'auto': tier = complexity.classify(req)              # §7.6
  list  = tiers[tier].candidates
  if route.allow_escalation: list += tiers[nextTierUp(tier)].candidates
  if req.priority in {interactive, important}: list += crossProviderFallbacks(tier)
  return list.filter(m =>
      m.enabled and m.provider.enabled
      and m.capabilities ⊇ route.required_capabilities ∪ needs(req)   # tools, vision, json_schema
      and m.context_window >= estimateInput(req, m) + maxOutput(req, m)
      and rank(m.provider.max_sensitivity) >= rank(req.sensitivity))
```

Health and budget are checked per attempt (§7.2), not at planning time, because both change while a request is running.

### 7.2 Attempt loop and failover

```
stream(req):
  candidates = plan(req)
  for model in candidates:
    if health.blocked(model): record skip; continue
    est = estimator.estimate(model, req)                         # §7.3
    r = budget.reserve(est, req.priority, model.provider, req.route)
    if not r.ok:
      if r.action == 'downgrade': continue                       # cheaper candidates come later in the list
      if r.action == 'defer':     throw Deferred(r.retryAt)      # scheduler reschedules the job
      if r.action == 'ask':       throw BudgetApprovalNeeded(r)  # chat shows continue / downgrade / stop
      throw BudgetBlocked(r)
    for try in 0..sameModelRetries(req.priority):                # interactive 0, background 2 (exp. backoff + jitter)
      started = false
      try:
        for ev in adapter.stream(model, req, timeouts(req.priority)):
          started ||= ev.type in {text-delta, tool-call}
          yield ev
        ledger.record(ok); budget.settle(r, actual); health.success(model); return
      catch err:
        c = adapter.classifyError(err)
        ledger.record(error, partialUsage); health.failure(model, c)
        if c not in RETRYABLE: budget.release(r); throw
        if started:
          if req.priority != 'interactive': budget.release(r); throw
          yield { type: 'reset', reason: c }
        if c in {rate_limited, quota_exhausted, auth_error}: break    # don't retry the same model
    budget.release(r)
  throw AllCandidatesFailed(attempts)
```

| Setting | Interactive | Background |
|---|---|---|
| Time to first token timeout | 20 s | 60 s |
| Total attempt timeout | 180 s | 300 s |
| Same-model retries | 0 | 2 |
| Mid-stream failover | yes (`reset`) | no (job retry) |
| Escalation to a pricier tier | if route allows | only if route allows; otherwise defer |

Circuit breaker per model: open after 5 consecutive failures, or ≥ 50 % failures over ≥ 10 calls in 60 s. Cooldown starts at 30 s, doubles per reopen, caps at 10 min; then half-open lets one probe through. `retry-after` overrides the cooldown when longer. `quota_exhausted` and `auth_error` disable the provider until the owner acts or the provider's reset time passes, and raise an alert.

Rate-limit headroom: when a provider's last reported remaining requests or tokens fall below 15 % of its limit, background requests skip that provider until the reset time, keeping capacity for interactive use.

Cross-provider details: tool-call ids are re-mapped per provider; provider-specific reasoning payloads (signed thinking blocks and similar) are kept for same-provider continuation and dropped when a run switches provider.

### 7.3 Cost estimation and calibration

- **Input tokens.** OpenAI-family models: `gpt-tokenizer` with the model's encoding. Other models: `ceil(chars / ratio[model])`, where `ratio` starts at 3.5 and is updated after every call with an exponential moving average (α = 0.1) of `actual_input_tokens / chars`. Images use each provider's documented per-image formula.
- **Output tokens.** p95 of output tokens over the last 200 calls for that `(route, model)`, falling back to `min(max_output_tokens, 1024)`. Reasoning models add the p95 of reasoning tokens.
- **Cached input.** Estimated from the previous call's cached share in the same session, so long sessions aren't over-reserved.
- **Reservation amount** = estimate × 1.25. Settlement uses the provider's reported usage. Every call stores estimate and actual, and the dashboard shows estimator error per model.

### 7.4 Budget reservations

```sql
-- One transaction per reservation. Budgets are locked in id order to avoid deadlocks.
BEGIN;
SELECT id, limit_usd, interactive_reserve_usd, hard_action
  FROM budgets WHERE id = ANY($applicable) AND enabled ORDER BY id FOR UPDATE;
INSERT INTO budget_counters (budget_id, period_start) VALUES (...)       -- create current period rows
  ON CONFLICT DO NOTHING;
SELECT budget_id, spent_usd, reserved_usd FROM budget_counters
  WHERE (budget_id, period_start) IN (...) FOR UPDATE;
-- For each budget: effective_limit = limit_usd - (priority = 'interactive' ? 0 : interactive_reserve_usd)
-- Deny (returning the budget's hard_action) if spent + reserved + estimate > effective_limit.
UPDATE budget_counters SET reserved_usd = reserved_usd + $estimate WHERE ...;
INSERT INTO budget_reservations (...) VALUES (...);                       -- one row per budget, 10 min TTL
COMMIT;
```

Settle: `reserved -= estimate`, `spent += actual`, reservation `settled`. Release: `reserved -= estimate`. A sweeper releases reservations whose TTL passed (the process died mid-call). Applicable budgets for a request: global, the provider's, the route's, and the priority class's. Periods start at midnight, Monday, or the 1st in the owner's timezone.

Threshold alerts fire once per threshold per period. Anomaly check every 5 minutes: if spend over the last hour exceeds 3× the trailing 7-day hourly average and is above $0.25, alert and switch to Economy.

### 7.5 Power modes and admission

| Mode | interactive | important | routine | deferrable |
|---|---|---|---|---|
| `normal` | run | run | run | run |
| `economy` | run (fast/balanced unless explicitly asked) | run, tier capped at balanced | run on fast tier only | wait for the nightly window (02:00–06:00) |
| `background_paused` | run | wait | wait | wait |
| system `stopped` (overrides any mode) | blocked | blocked | blocked | blocked |

`admit(priority)` combines the mode with budget state: a priority class whose budgets are at their hard limit gets `{ admitted: false, retryAt: nextPeriodStart }`. The scheduler reschedules refused jobs with pg-boss `startAfter`; they are never dropped. Model-free jobs (backups, integrity checks, heartbeat) don't call `admit` and keep running in every mode except `stopped`. Backups and the heartbeat keep running even in `stopped`, because they don't act on the world.

### 7.6 Complexity classifier (`tier: auto`)

Score from 0 to 1 using cheap features: message length; code blocks or stack traces; words like "plan", "compare", "analyze", "debug", "step by step", "write a"; number of distinct entities; attachments (vision needed); conversation depth; and the tier and outcome of the previous turn.

| Score | Tier |
|---|---|
| < 0.35 | fast |
| 0.35–0.70 | balanced |
| > 0.70 | frontier |

Inside the uncertain bands (0.30–0.40 and 0.65–0.75), a fast-tier model classifies the request (about 150 tokens). Overrides: "think hard" or the UI's tier selector forces frontier; "quick" forces fast. A run keeps its model for every step, for coherence and prompt caching. Escalation (two invalid tool calls, thumbs-down, "try again harder") moves the session up one tier for the next 5 turns. Every decision is logged with its features, so thresholds can be tuned from real feedback.

### 7.7 Context assembly and prompt caching

Default input-token target for `chat.turn`: 12k on fast, 16k on balanced, 24k on frontier.

| Section | Budget | Changes |
|---|---|---|
| System instructions, persona, safety rules | ~1.5k | Rarely (cache breakpoint 1) |
| Tool schemas for active toolsets | ~1–3k | When toolsets change |
| Core memory block + standing rules | ≤ 1.2k | Daily (cache breakpoint 2) |
| Rolling session summary | ≤ 1k | At compaction |
| Earlier turns, verbatim | remainder | Append-only |
| Latest message + retrieved memories | ≤ 2.5k memories | Every turn |

- Anthropic: explicit `cache_control` at the two breakpoints and at the last earlier turn. OpenAI: automatic prefix caching with a stable `prompt_cache_key` per session. Gemini: implicit caching. Cached tokens are recorded in the ledger.
- `messages.rendered_context` stores the exact memory block sent with each user turn, so the next request reproduces earlier turns byte for byte.
- Compaction: when earlier turns exceed their share, the oldest ones are folded into the rolling summary by the fast tier, keeping the last 6 turns verbatim. Tool results in earlier turns are replaced by their stored summaries.
- Toolsets: `memory`, `time`, `plan` and `notify` are always offered; `web` and `files` only when the classifier or the conversation indicates them.

### 7.8 Memory extraction and reconciliation

**Trigger.** Debounced per session: run when 6 new messages accumulate or 2 minutes pass after the last one. Immediate when the owner says "remember …" (direct write, `owner_asserted`, confidence 1.0, importance ≥ 0.7). Every pending batch flushes when the session goes idle.

**Extraction output** (structured output, fast tier, versioned prompt):

```json
{
  "candidates": [{
    "layer": "semantic",
    "kind": "preference",
    "content": "The owner prefers short answers without bullet lists for casual questions.",
    "entities": [{ "name": "owner", "kind": "person", "role": "subject" }],
    "relations": [],
    "importance": 0.55,
    "confidence": 0.7,
    "owner_asserted": false,
    "valid_from": null,
    "sensitivity": "normal",
    "evidence_message_ids": ["0193..."]
  }],
  "corrections": [{ "about": "sister's name", "new_content": "The owner's sister is named Lina." }]
}
```

Prompt rules: only durable information (facts, preferences, relationships, commitments with dates, plans, recurring patterns, standing instructions as `procedural/rule`); one atomic statement per candidate in third person; never extract the assistant's own claims unless the owner confirmed them; mark inferred items as such; skip credentials (a regex and entropy filter also runs before and after the model).

**Reconciliation**, per candidate:
1. Suppression check: drop if the content hash matches, or cosine ≥ 0.90 with a suppression embedding.
2. Neighbors: top 5 active memories in the same layer with cosine ≥ 0.75, plus memories sharing the subject entity.
3. No neighbors: **add**.
4. Otherwise a fast-tier call decides `add | update(id) | supersede(id) | noop(id)` with a reason. Fixed rules then apply:
   - Owner-asserted candidate that contradicts a neighbor: **supersede** (neighbor gets `valid_to = now`, status `superseded`, link `contradicts`).
   - Inferred candidate that contradicts an owner-asserted neighbor: never supersede; add it with confidence ≤ 0.4, a `contradicts` link, and flag it for review.
   - `noop` on a duplicate: `evidence_count += 1`, `confidence = 1 − (1 − confidence) × 0.7`, capped at 0.95 for inferred memories.
5. Every outcome writes a `memory_events` row with the extractor as actor and the reason.

Inferred candidates below confidence 0.4 are stored as `archived` (kept, but hidden from retrieval) until evidence accumulates.

### 7.9 Retrieval scoring

For a query, run three retrievers (50 candidates each, active and currently valid, sensitivity ≤ the provider's limit):

```
rrf(m)   = Σ over retrievers r of 1 / (60 + rank_r(m))        # vector, full-text, entity
w_imp    = 0.5 + importance                                    # 0.5 .. 1.5
w_rec    = 0.5 + 0.5 · 2^(−age / half_life(kind))              # 0.5 .. 1.0
w_conf   = 0.5 + 0.5 · confidence                              # 0.5 .. 1.0
score(m) = rrf(m) · w_imp · w_rec · w_conf
```

`age` is measured from `occurred_at` for episodic memories and from `updated_at` for the others. Half-lives: events 30 days, conversation episodes 60 days, digests 180 days, facts and preferences 365 days, procedures and rules no decay. Pinned memories skip ranking because they are already in the core block. The top 30 go through MMR (λ = 0.7) and are packed into the token budget (default 8–12 memories). Historical questions ("what did I think about X last year") disable the validity filter and the recency weight. Access counters are updated asynchronously and do not feed the score, which avoids a rich-get-richer loop.

### 7.10 Consolidation jobs

| Job | Schedule | Priority | Work |
|---|---|---|---|
| `memory.session-episode` | 30 min after a session's last message (pg-boss singleton key per session) | routine | Flush extraction; summarize the session into a `conversation` episode with `part_of` links to its messages |
| `memory.nightly` | 03:30 owner time | deferrable | Daily digest episode; near-duplicate merge (cosine ≥ 0.92, same subject entity, model-confirmed; survivor keeps the highest confidence, the others become `merged`); importance recompute; entity summary refresh; core block regeneration; procedure proposals from repeated requests (stored as suggestions, never auto-activated) |
| `memory.rollup` | Mondays and the 1st, 04:00 | deferrable | Weekly and monthly digests |
| `memory.integrity` | 04:30 daily | none (no model) | Missing embeddings, stale `fts`, orphans; repairs enqueued |
| `memory.reembed` | When an embedding space is created | deferrable | Re-embed in batches of 256 under the deferrable budget |

Importance recompute: `importance = clamp(0.6 · base + 0.2 · min(1, log10(1 + evidence_count)) + 0.2 · link_centrality, 0, 1)` where `base` is the extractor's or owner's value. Pinned and owner-asserted memories never drop below their base.

### 7.11 Taint escalation

- Tools flagged `untrustedOutput` (`web.fetch`, `web.search` results; email and messaging tools in Phase 3) add their source to the run's taint set.
- In a tainted run, `external_write`, `communicate`, `destructive` and `device_control` resolve to `ask` whatever the matrix says; the approval card lists the taint sources.
- Untrusted text enters the prompt inside `<untrusted source="…">…</untrusted>` blocks; the system prompt states that instructions inside them must not be followed.
- Taint doesn't spread into memory as authority: memories extracted from untrusted content get `source = imported`, confidence ≤ 0.5, and can never become `procedural/rule`.

### 7.12 Kill switch and crash recovery

**STOP:**
1. Persist `system_state.state = stopped` (actor, reason).
2. Abort every in-flight run's AbortController; adapters cancel their HTTP streams.
3. Pause pg-boss intake for every queue except backups and heartbeat.
4. Policy Gate returns `deny` for every call while stopped. This is the backstop if any code path were missed.
5. Mark aborted runs `cancelled` with reason `system_stop`; publish `system.state`.
6. Target: everything halted within 1 second.

**Resume:** owner-only, with the password re-entered (passkey in Phase 2). Cancelled runs stay cancelled; the owner can retry them individually.

**Boot recovery:** runs found `running` become `interrupted`. Background runs whose next step is a model call (idempotent) are re-enqueued automatically, up to 2 resumes. Runs whose last step was a side-effecting tool call in `running` state are checked against the tool's idempotency record: completed calls are marked done, unknown outcomes go to the owner as "verify and resume?". Interactive runs show a "resume?" banner in their session.

### 7.13 Audit hash chain

```
hash_n = SHA-256( prev_hash || canonical_json(entry_n without hash) )
```

Inserts are serialized with an advisory lock so the chain stays linear. `feroxes audit:verify` recomputes the chain and reports the first broken row. Verification runs daily and its result shows on the dashboard. Anchoring the daily head outside the database follows in Phase 2.

## 8. API surface (Phase 1)

All under `/api`, JSON, Zod-validated, owner session required except setup and login.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/setup` (only while no owner exists) · `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` · `POST /auth/totp` |
| Sessions and chat | `GET /sessions` · `POST /sessions` · `GET /sessions/:id` · `GET /sessions/:id/messages?before=` · `POST /sessions/:id/messages` → `{ runId }` · `POST /messages/:id/feedback` · `POST /messages/:id/remember` |
| Runs | `GET /runs?status=&trigger=` · `GET /runs/:id` (with steps, tool calls, usage) · `POST /runs/:id/cancel` · `POST /runs/:id/retry` (optionally with a higher tier) |
| Approvals | `GET /approvals?status=pending` · `POST /approvals/:id` `{ decision, editedArgs? }` |
| Events | `GET /events?topics=&session=` (SSE, honors `Last-Event-ID`) |
| Memory | `GET /memories?layer=&kind=&entity=&status=&sensitivity=&from=&to=` · `POST /memories/search` `{ query, explain }` · `GET /memories/:id` · `POST /memories` · `PATCH /memories/:id` · `POST /memories/:id/pin` · `POST /memories/:id/archive` · `POST /memories/:id/restore` · `DELETE /memories/:id?suppress=` · `POST /memory-events/:id/undo` · `GET /memory/core` · `PUT /memory/core/notes` · `GET /entities` · `GET /entities/:id` · `POST /memory/export` |
| Providers and routing | `GET/POST /providers` · `PATCH/DELETE /providers/:id` · `POST /providers/:id/test` · `POST /providers/:id/sync-models` · `GET/PATCH /models` · `GET/PUT /routing` (tiers and routes) · `GET /providers/health` |
| Usage and budgets | `GET /usage/summary?period=` · `GET /usage/timeseries?groupBy=&from=&to=` · `GET /usage/events?…` · `GET/POST /budgets` · `PATCH/DELETE /budgets/:id` · `GET /budgets/status` |
| Policy and audit | `GET/PUT /policy` (preset, matrix, overrides) · `GET /audit?…` · `GET /audit/verify` |
| System | `GET /system/status` · `POST /system/stop` · `POST /system/resume` · `PUT /system/power-mode` · `GET /notifications` · `POST /notifications/:id/read` · `GET /backups` · `POST /backups/run` |
| Health | `GET /healthz` · `GET /readyz` (outside `/api`, no auth, no details) |

## 9. Configuration and defaults

### 9.1 Backups and export
- Nightly at 04:00 owner time: `pg_dump -Fc | age -r $BACKUP_AGE_RECIPIENT > backups/feroxes-<ts>.dump.age`, with a manifest (size, sha256, row counts per table, audit chain head).
- Retention: 7 daily, 4 weekly, 12 monthly.
- Weekly: JSONL export of memories, entities and relations, encrypted the same way. Readable without Feroxes.
- `feroxes backup:verify --identity <age key file>` restores the latest dump into a scratch database, checks row counts and the audit chain, and drops the scratch database.
- The Core image ships `pg_dump` for the same Postgres major version and the `age` CLI.

### 9.2 Default tiers and routes (`config/routing.default.yaml`)

```yaml
tiers:   # ordered; the same model through OpenRouter is the last resort when a direct provider throttles
  frontier: [anthropic/claude-opus-5.5, openai/gpt-6-astra, openrouter/anthropic/claude-opus-5.5]
  balanced: [anthropic/claude-sonnet-5.5, openai/gpt-6.1-sol, google/<flash-model>, openrouter/anthropic/claude-sonnet-5.5]
  fast:     [anthropic/claude-haiku-5.5, openai/gpt-6-luna, google/<flash-lite-model>, openrouter/<cheap-model>]
  local:    [ollama-pc/<model>]   # optional: Ollama on the owner's PC over Tailscale, skipped while the PC is off

routes:
  chat.turn:          { tier: auto,   needs: [tools, streaming], priority: interactive, input_target: auto }
  agent.plan:         { tier: frontier, priority: interactive, allow_escalation: false }
  memory.extract:     { tier: fast, needs: [json_schema], priority: routine, max_output: 1500 }
  memory.reconcile:   { tier: fast, needs: [json_schema], priority: routine, max_output: 400 }
  memory.consolidate: { tier: fast, needs: [json_schema], priority: deferrable }
  session.summarize:  { tier: fast, priority: routine }
  query.rewrite:      { tier: fast, priority: interactive, max_output: 120 }
  classify:           { tier: fast, needs: [json_schema], priority: important, max_output: 150 }
  embed:              { kind: embedding, space: active }
```

Model ids are placeholders until the catalog is seeded and checked against each provider's model list at implementation time.

### 9.3 Baseline cost estimate

Assumptions: 50 chat turns a day; fast tier at $0.10 / $0.50 per 1M input/output tokens, balanced at $2 / $10, frontier at $4 / $20 (the October 2026 Claude list prices in the tech stack doc); about 75 % of chat input served from prompt cache at roughly 10 % of the input price; embeddings at $0.02 per 1M tokens; cache-write surcharges ignored.

| Workload | Per day | Per month |
|---|---|---|
| Background memory work (extraction, reconciliation, session episodes, nightly consolidation, embeddings) on the fast tier | ≈ $0.03 | ≈ $1 |
| Chat, mixed tiers (50 % fast, 30 % balanced, 20 % frontier) | ≈ $0.60 | ≈ $18 |
| Chat, all balanced | ≈ $0.70 | ≈ $21 |

The background baseline is small when it stays on the fast tier, which is why the router refuses to escalate background work by default. Interactive use on the higher tiers is where the budget actually goes. These are estimates; the ledger replaces them with real numbers in the first week.

### 9.4 First-run wizard and suggested budgets
1. Create the owner account (password ≥ 12 characters, optional TOTP).
2. Add providers: key, test, sync models. At least two providers are needed for failover; three or more are recommended.
3. Pick the embedding space (hosted default or a local model).
4. Budgets, pre-filled and editable:

| Budget | Suggested limit | Hard action |
|---|---|---|
| Global, monthly | $30 | ask |
| Global, daily | $2, of which $0.50 is an interactive reserve | ask (interactive), defer (background) |
| Background (`routine` + `deferrable`), daily | $0.25 (about 8× the expected baseline, so runaway loops are caught early) | defer |
| Per provider, daily | none by default | |

5. Choose the autonomy preset (default: Assistant).

## 10. Testing and evaluation

| Level | What | Where |
|---|---|---|
| Unit | Scoring, decay, reconciliation rules, estimator, cost math, policy decisions, classifier, hash chain | `*.test.ts`, every PR |
| Integration | Repositories, reservations under concurrency, triggers, retrieval with real indexes, job flows | Testcontainers, every PR |
| Adapter contracts | Each adapter against recorded fixtures (streaming, tool calls, usage, error mapping) | Every PR; live smoke test opt-in with real keys |
| Chaos | Mock provider injecting each error class, mid-stream failures, slow first tokens, header-reported rate limits | Every PR |
| Memory eval | Synthetic owner with 150 facts across 40 scripted conversations, 120 queries with expected memory ids, 15 contradictions, 10 delete-and-suppress cases | Nightly; capped at about $0.50 per full run on the fast tier |
| Routing eval | 100 labeled prompts to measure tier choice | On classifier changes |
| End-to-end | Playwright: setup, chat with a tool and an approval, memory edit and delete, budget edit, STOP and resume | Every PR (mock provider) |
| Soak | 24 hours: scripted chats every few minutes, all background jobs, random provider failures | Before closing the phase |

Memory eval targets for the baseline: recall@5 ≥ 0.85, MRR ≥ 0.70, contradiction resolution ≥ 0.90, duplicate rate ≤ 5 %, zero suppression leaks.

## 11. Acceptance criteria (Phase 1 exit)

1. **Failover.** With three providers configured and the primary forced to return 429, then 500, then a timeout, chat turns still succeed. The ledger shows every attempt, and the dashboard shows the primary's health state.
2. **Accounting.** Every model and embedding call has a ledger row. Costs match hand calculation from the price table within $0.000001 per call; dashboard totals equal ledger sums.
3. **Budgets.** With a $0.05 daily background budget and 20 concurrent background jobs, spend never exceeds the limit by more than the in-flight reservations; refused jobs are rescheduled to the next period; the 80 % alert fires once; chat keeps working inside the interactive reserve and asks the owner past it.
4. **Memory.** "Remember that my sister's name is Leila" is recalled in a new session. "Actually, her name is Lina" supersedes it, with the old version visible in history. Deleting with suppression prevents re-extraction from old conversations. The memory eval meets its targets.
5. **Consolidation.** An idle session becomes an episode; the nightly job produces a digest and a new core block; row-count invariants show no raw message was deleted.
6. **Kill switch.** STOP halts a streaming run within 1 second, keeps queued jobs from starting, and every tool call is denied until the owner resumes. A Core restart while stopped comes back stopped.
7. **Approvals.** An `ask` tool call pauses its run; the Core restarts while it waits; approving after the restart resumes the run and the call executes exactly once.
8. **Audit.** `audit:verify` passes on a clean log and reports the exact row after a manual tamper.
9. **Soak.** 24 hours with no unhandled rejections, no stuck runs, no leaked reservations, and resident memory growth under 15 %.
10. **Backup.** A backup restores into a fresh database with matching row counts and a valid audit chain.
11. **UI.** Every Phase 1 screen works at desktop and phone widths, and the app installs as a PWA.

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Provider APIs and SDKs change | Adapters isolated behind `ProviderAdapter`; contract tests; AI SDK upgraded deliberately |
| Extraction stores wrong or noisy memories | Atomic statements with provenance; inferred vs. asserted; low-confidence items archived until evidence accumulates; owner review in the UI; eval set |
| Runaway cost from loops or retries | Per-run limits, loop detection, reservations, background budget, no background escalation, spend-rate anomaly switch to Economy |
| Prompt injection through web content | Taint tracking, forced approvals, untrusted delimiters, no rules learned from untrusted content |
| Embedding model change strands old vectors | Embedding spaces with partial indexes and background re-embedding |
| TS 7 tooling gaps | Oxlint and Next.js 16.3+ already support it; a single tool that still needs the TS 6 API can run against a pinned TS 6 alias |
| Prices drift | Prices are data with effective dates; the dashboard flags models with no price for the current date |
| Scope creep | Milestones with explicit "done when" checks; new ideas go to the roadmap |

## 13. Owner decisions

### Decided (2026-11-07)
1. **Core host:** Oracle Cloud Always Free ARM VM for production; the owner's PC for development and, later, the desktop agent. One production Core at a time (architecture §4.1).
2. **Providers:** Anthropic, OpenAI, Google Gemini, OpenRouter. Kiro can't be used as a provider (tech stack §3.2). Local models are optional, through Ollama on the PC.

### Still open (defaults apply until the owner says otherwise)
3. **Budget:** default is the §9.4 suggestion ($30 a month, $2 a day).
4. **Repository:** the owner creates an empty private repository (the Kiro Agent GitHub app can't create one) and gives the app access to it.
5. **Stack:** TypeScript Core and UI, Rust desktop agent, Kotlin Android agent. No objection so far.
6. **Phase order:** integrations (Phase 3) before device control (Phase 4). No objection so far.

### Environment needed before M0
The planning sandbox has no access to the npm registry and no container runtime, so packages can't be installed and tests can't run there. M0 needs a session with:
- Kiro Web **Settings → Sandbox → Internet access** set to *Common dependencies* (it includes npmjs.org). If `registry.npmjs.org` is still blocked, add `.npmjs.org` to the custom allow-list ([Kiro docs](https://kiro.dev/docs/web/sandbox/internet-access)).
- GitHub connected under **Settings → Integrations**, and the Feroxes repository selected when the session starts ([Kiro docs](https://kiro.dev/docs/web/github)).
- Integration tests that need Postgres run in CI (GitHub Actions service container with `pgvector/pgvector:pg18`) whenever the sandbox can't start containers.

## 14. Implementation status

Updated 2026-11-07. The planning sandbox could not reach the npm registry or run containers, so this round implemented everything that doesn't need Postgres, Fastify or Next.js, and tested it with zero-install tooling: Node's built-in test runner, TypeScript 7 for type checking, and the only runtime dependency, Zod.

### Done (90 tests, all passing)

| Milestone | Status | What exists |
|---|---|---|
| M0 Platform skeleton | Partial | Workspace, tsconfig (TS 7, strict, erasable syntax so Node runs `.ts` directly), CI workflow, `.env.example`, config validation, AES-256-GCM vault with key rotation and purpose binding, argon2id password hashing, CLI. Missing: Fastify server, auth sessions, migration runner |
| M1 Data model | Not started | Store interfaces exist for every table in §5; in-memory implementations back the tests. Drizzle schema and migrations need npm |
| M2 Intelligence layer | Done | Router (§7.1–7.2), circuit breakers, rate-limit headroom, cost estimator with calibration (§7.3), complexity classifier (§7.6), adapters for OpenAI, OpenAI-compatible, Anthropic, Gemini, and a mock provider. Adapters are tested against wire-format fixtures; a live smoke test with real keys is still needed |
| M3 Metering | Done | Prices with effective dates and cache/context tiers, ledger, budgets with atomic reservations and interactive reserve (§7.4), thresholds, power modes and admission (§7.5), anomaly detection |
| M4 Policy and tools | Done | Presets, hard floor, taint escalation (§7.11), kill switch (§7.12), approvals, hash-chained audit with verifier (§7.13), Tool Runtime with idempotency and output shaping, sandboxed files, SSRF-safe web fetch |
| M5 Agent runtime | Done | Persisted runs and steps, streaming loop, approvals that survive restarts, resume of interrupted background runs, loop and limit guards, six-layer cache-friendly context with compaction (§7.7) |
| M6 Memory engine | Mostly done | Hybrid retrieval (§7.9), extraction and reconciliation with fixed rules (§7.8), supersede, evidence, undo, suppression, sensitivity filtering, session episodes, nightly merge/importance/core block, daily digest, JSONL export. Missing: Postgres store with HNSW indexes, encrypted `pg_dump` backups, weekly/monthly roll-ups |
| M7 API and web UI | Not started | Needs Fastify and Next.js |
| M8 Hardening | Not started | |

Acceptance criteria from §11 already covered by tests: 1 (failover), 2 (accounting, per call), 3 (budgets under concurrency), 4 (memory scenarios), 6 (kill switch, in-process), 7 (approval across restart, exactly once), 8 (audit tamper detection). The rest need the database, the API or the UI.

### Decisions changed during implementation

| Planned | Built | Why |
|---|---|---|
| Vercel AI SDK 6 provider packages under the adapters | Direct HTTP adapters (fetch + SSE parser) | No registry access in the sandbox, and direct adapters give exact control over cache breakpoints, rate-limit headers and error classification. The `ProviderAdapter` interface is unchanged, so an AI SDK-backed adapter can still be added |
| Vitest | Node's built-in `node:test` for server packages | Zero dependencies and fast. Vitest can still be used for the web app |
| `@node-rs/argon2` | `crypto.argon2` built into Node ≥ 24.7 | One less native addon, which matters on the ARM VM |
| Money as `numeric(14,8)` | Integer nano-dollars in code, `numeric(18,9)` in Postgres | Exact sums under concurrency; embedding calls don't round to zero |

### Next steps (in order)
1. Push this branch and open a PR (needs a GitHub repository, see the session summary).
2. In a session with npm access: `pnpm install`, commit the lockfile, CI green.
3. M1: Drizzle schema and migrations for §5, Postgres implementations of every store interface, Testcontainers integration tests.
4. M0 remainder: Fastify server, owner setup and login, sessions, host allowlist, health endpoints, single-Core lease.
5. pg-boss scheduler: debounced extraction, session episodes, nightly consolidation, reservation sweeper, backups.
6. M7: REST + SSE API, then the Next.js PWA.
7. Live smoke test against Anthropic, OpenAI, Gemini and OpenRouter with the owner's keys; verify seed model ids and prices.
