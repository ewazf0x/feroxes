> **Revision 2 (2026-11-08):** hosting, storage, user interface, phase order and the Kiro decision changed. See [06 Revision 2](06-revision-pc-apps-brain.md).

# Feroxes: High-Level Architecture

> Status: draft for review · 2026-11-07
> Related: [02 Tech stack](02-tech-stack.md) · [03 Project structure](03-project-structure.md) · [04 Phase 1 plan](04-phase-1-plan.md) · [05 Roadmap](05-roadmap.md)

## 1. Scope and boundaries

Feroxes is a personal AI system for one person, the owner. It runs continuously on an always-on host, keeps a long-term memory of the owner's life and work, spreads model calls across several AI providers within a budget, acts on the owner's devices and accounts, and talks and listens through voice.

Three boundaries shape every design decision:

- **One owner.** There are no user accounts, tenants, or sharing features. Authentication exists to keep everyone else out.
- **Only the owner's own accounts and devices.** Feroxes reads messages that other people sent *to the owner* through the owner's accounts. It never logs into, scrapes, or monitors anyone else's accounts.
- **Owner in control.** Every outward action passes one policy gate, is logged, and can be stopped by one kill switch.

## 2. Design principles

| # | Principle | What it means in practice |
|---|---|---|
| P1 | Owner stays in control | Permission levels per action type, approvals for risky actions, one kill switch that halts everything, a complete audit trail. |
| P2 | Nothing important is lost | Raw interactions are stored append-only. Summaries and facts are derived from them and can be rebuilt. Only the owner deletes. |
| P3 | Cost is a runtime constraint | No component calls a model provider directly. Every call goes through the router, which checks budgets before the call and records the actual cost after it. |
| P4 | One gate for side effects | Tools are the only way to touch the outside world, and every tool call goes through the Policy Gate: decide, maybe ask, execute, audit. |
| P5 | Untrusted content is data | Emails, web pages and messages from other people can inform the agent but never authorize actions. Runs that read them are marked tainted and lose auto-approval for outward actions. |
| P6 | Durable by default | Runs, steps, approvals and jobs live in Postgres. A restart resumes work instead of losing it. Side-effecting tool calls carry idempotency keys so they never run twice. |
| P7 | Ports and adapters | Providers, connectors, devices and voice engines sit behind interfaces. Domain code never imports a vendor SDK. |
| P8 | Few moving parts | One PostgreSQL instance holds state, vectors, full-text search, jobs, the ledger and the audit log. New infrastructure is added only for a measured need. |

## 3. System overview

```
                 ┌──────────────────────── Owner ─────────────────────────┐
                 │  PWA (desktop + mobile)   Push-to-talk   Notifications  │
                 └──────────┬──────────────────────┬──────────────▲───────┘
                            │ HTTPS: REST + SSE    │ audio        │ web push / voice
┌───────────────────────────▼──────────────────────▼──────────────┴──────────────────────┐
│                          FEROXES CORE  (always-on host, Node.js)                        │
│                                                                                          │
│  API Gateway: auth · REST · SSE event stream · device WebSocket hub                     │
│                                                                                          │
│  Agent Runtime        Memory Engine          Intelligence Layer     Policy Engine        │
│  runs · loop ·        working · episodic ·   providers · router ·   permissions ·        │
│  context builder      semantic · procedural  failover · embeddings  approvals · taint ·  │
│                                                                     kill switch · audit  │
│  Tool Runtime         Metering               Scheduler & Proactive  Connectors · Devices │
│  registry · MCP ·     ledger · budgets ·     jobs · cron · monitors · Voice              │
│  idempotency          reservations · modes   triggers · briefings                        │
│                                                                                          │
│  Event Bus (typed, in-process)                                                           │
│  PostgreSQL 18 + pgvector: state · memory · vectors · full-text · jobs · ledger · audit  │
└───────┬──────────────────────────────┬───────────────────────────────┬──────────────────┘
        │ HTTPS                        │ WSS over Tailscale             │ OAuth / API keys
        ▼                              ▼                                ▼
  Model providers               Device agents                    Owner's services
  OpenAI · Anthropic · Google   Desktop (Tauri/Rust, Win/macOS)  Gmail · Outlook · Calendar
  OpenAI-compatible · Ollama    Android (Kotlin, Accessibility)  GitHub · Discord bot
  ElevenLabs (TTS/STT)                                           WhatsApp bridge · Browser
```

The system has three kinds of parts:

| Part | Role | Runs on | State it holds |
|---|---|---|---|
| Core | Brain: reasoning, memory, routing, policy, scheduling, integrations | One always-on host | All durable state, in PostgreSQL |
| Device agents | Hands: execute device actions, report device events | Each controlled PC and phone | Local config, pairing keys, a short action buffer |
| Clients | Face: chat, dashboard, settings, approvals, voice | Browser (PWA) on desktop and mobile | Cache only |

## 4. Deployment topology

Feroxes is hub-and-spoke:

- **Core** runs on one always-on host. Recommended: a home server or mini-PC, so the data stays at home. A small VPS works if its disk and the backups are encrypted. Running the Core on the owner's main PC is fine for development, but then "24/7" means "while the PC is on".
- **Device agents** run natively on each controlled device and dial *out* to the Core, so they work behind NAT and never open ports.
- **Clients** are the PWA on desktop and phone.

Networking: every component joins the owner's Tailscale tailnet. The Core listens only on localhost and the tailnet interface; nothing is exposed to the public internet by default. If a later integration needs inbound webhooks, it goes through a narrowly scoped relay that is off by default.

Runtime layout on the Core host (Docker Compose):

| Container | Purpose |
|---|---|
| `postgres` | PostgreSQL 18 with pgvector (`pgvector/pgvector:pg18`) |
| `core` | Feroxes Core: API, agent runtime, workers, scheduler. One process in Phase 1, built so it can split into `api` and `worker` roles later |
| `web` | Next.js PWA server |
| `caddy` | TLS and routing: `/api/*` to core, everything else to web. Same origin, so cookies and SSE work without CORS |

### 4.1 Chosen hosting (owner decision, 2026-11-07)

| Role | Where | Notes |
|---|---|---|
| Production Core + Postgres, 24/7 | Oracle Cloud Always Free, Ampere A1 VM (ARM64) | Since 15 June 2026 the free A1 allowance is 2 OCPUs and 12 GB RAM in total ([InfoQ](https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/)). Enough for Phases 1 to 3 |
| Development, and later the desktop agent | Owner's PC | Its own dev database. Never a second production Core |

Memory plan for the 12 GB VM: Postgres 2–3 GB (`shared_buffers` 1 GB), Core 0.5–1 GB, Next.js about 0.3 GB, Caddy and Tailscale under 0.2 GB, leaving room for Playwright browsers in Phase 3 (about 1 GB each). There is no GPU, so local models don't run on this host.

Oracle-specific rules:
- Every image is built and pulled as `linux/arm64`. Node, Caddy and pgvector publish multi-platform images; the first deploy checks this.
- No inbound ports are opened in the VM's security list. The VM is reached only through Tailscale, SSH included.
- Oracle may reclaim Always Free instances that look idle over a 7-day window (low CPU, network and memory use), and Feroxes is idle most of the time. Upgrading the tenancy to Pay As You Go is the usual protection (nothing is charged while usage stays inside the free limits). Check Oracle's current free-tier page before relying on that. Nightly offsite backups to Oracle Object Storage (S3-compatible) are the second line of defense.
- Size the VM at or below 2 OCPUs and 12 GB. Free-tier instances above the new limit were stopped and disabled in an enforcement wave around 2026-08-18 ([Oracle community thread](https://community.oracle.com/CustomerConnect/discussion/974679/always-free-a1-instance-disabled-cannot-resize)).
- Busy regions sometimes have no free A1 capacity, so creating the VM may need retries or another availability domain.
- Oracle encrypts block volumes at rest. Feroxes adds its own vault and age-encrypted backups on top.

**Exactly one production Core.** Running the Core sometimes on Oracle and sometimes on the PC, each with its own database, would split the memory into two copies that drift apart. So Oracle hosts the one production Core. Moving it (for example to the PC during an Oracle outage) is a scripted move: back up, restore on the other host, start there, and keep the old host stopped until moving back. The Core also takes a lease row in its database at boot, so a second Core pointed at the same database refuses to start its workers.

## 5. Core components

### 5.1 API Gateway
- REST for commands and queries, SSE for the live event stream to clients, WebSocket for device agents (UI traffic is request/response plus a one-way stream, so SSE is enough there; devices need two-way traffic).
- Authenticates the owner (session cookie) and devices (per-device tokens issued at pairing).
- Validates every request with the shared Zod schemas from `@feroxes/protocol`.
- Enforces a host allowlist (DNS-rebinding protection), CSRF rules and rate limits.

### 5.2 Agent Runtime
Executes **runs**. A run is one unit of agent work with a trigger (user message, schedule, external event, or parent run), a priority class, limits (steps, cost, wall time) and a persisted list of steps.

```
queued ─▶ running ◀──▶ waiting_approval
running ─▶ completed | failed | cancelled
running | waiting_approval ─▶ interrupted (process died) ─▶ running (resumed) | cancelled
```

One loop iteration is one step:
1. The Context Builder assembles the prompt (§7.6).
2. The router streams a model response (§8).
3. Each tool call goes to the Tool Runtime, which applies the Policy Gate (§9). Read-only calls may run in parallel; side-effecting calls run one at a time.
4. Results are appended and the loop repeats until a final answer, a limit, a cancellation, or an approval wait.

Every step is written to Postgres before the next one starts. A crash loses at most the step in flight, and the UI can replay any run. Concurrency: one interactive run per session at a time, global caps per priority class, and background runs never starve interactive ones.

### 5.3 Memory Engine
Owns all long-term memory: extraction, reconciliation, retrieval, consolidation, owner edits, export. See §7.

### 5.4 Intelligence Layer
Owns providers, the model catalog, routing, failover and embeddings. See §8.

### 5.5 Metering
Owns the usage ledger, pricing, budgets, reservations and power modes for every paid API: LLM tokens, embedding tokens, TTS characters, STT seconds, search API calls. See §8.4.

### 5.6 Tool Runtime
- Registry of tools: built-in, connector-provided, and imported from MCP servers. Each tool has a Zod input schema, a description written for the model, and risk metadata.
- The only path to side effects: `invoke()` runs the policy decision, an optional approval wait, execution with an idempotency key, and the audit write.
- Shapes outputs for the model: large results are stored as artifacts and truncated or summarized, so tool output doesn't flood the context window.
- Toolsets: tools are grouped (memory, files, web, email, desktop, ...) and only the relevant toolsets are offered per turn. Once there are hundreds of tools, this keeps tool schemas from eating the token budget.

### 5.7 Policy Engine
Permissions, autonomy presets, approvals, taint tracking, the kill switch and the hash-chained audit log. See §9.

### 5.8 Scheduler and Proactive Engine
- pg-boss queues and cron schedules for all background work: memory consolidation, backups, monitors, briefings.
- Before starting any job that will call a model, the scheduler asks Metering for admission. A refused job is rescheduled, not failed. This is how "pause non-critical background work to save tokens" is implemented.
- Phase 3 adds monitors (new email, upcoming deadline, trial ending), triggers, automation rules, briefings and the notification router. See §13.

### 5.9 Connector Framework (Phase 3)
A uniform way to add services: auth, multiple accounts per service, tools, triggers, sync cursors, health. See §11.

### 5.10 Device Hub (Phase 4)
Pairing, device registry, WebSocket sessions, capability negotiation, command dispatch with timeouts, heartbeats. See §10.

### 5.11 Voice Service (Phase 2)
STT and TTS behind provider interfaces, streaming audio, push-to-talk, and an input abstraction that is ready for a wake word. See §12.

### 5.12 Event Bus and Notifications
- A typed in-process event bus. Modules publish events such as `run.status`, `memory.created`, `budget.threshold`, `provider.health`.
- State-changing events are persisted with a sequence number, so a client that reconnects with `Last-Event-ID` catches up. Token deltas are not persisted; a reconnecting client gets a snapshot of in-flight runs instead.
- If the Core later splits into several processes, the bus switches to Postgres `LISTEN/NOTIFY` without changing publishers.
- Notifications are a separate concern with channels (in-app, web push, voice, email-to-self), severity, quiet hours and batching.

### 5.13 Web UI (PWA)
Chat, dashboard, memory browser, usage and budgets, activity and audit, approvals inbox, settings. Responsive from the first screen and installable as a PWA. Phase 1 ships the subset needed to operate and inspect the foundation (see the Phase 1 plan).

## 6. Key flows

### 6.1 Interactive chat turn
```
PWA ──POST /api/sessions/:id/messages──▶ API ──▶ store message (append-only) ──▶ create run (interactive)
PWA ◀───────────── SSE: run status, text deltas, tool cards, approval requests ─────────────┐
Agent Runtime: memory.buildContext ─▶ router.stream(route = chat.turn, tier = auto)          │
               ├─ budget reserve ─▶ provider (stream) ─▶ deltas ─────────────────────────────┘
               ├─ tool calls ─▶ Tool Runtime ─▶ Policy Gate ─▶ execute | ask | deny ─▶ audit
               └─ final answer ─▶ store message ─▶ ledger settle ─▶ enqueue memory.extract (debounced)
```

### 6.2 Approval
1. A tool call resolves to `ask`. The runtime stores an approval request with a preview (for example, the exact email text), the agent's stated reason, the risk category and any taint sources.
2. The run moves to `waiting_approval` and releases its worker. Waiting costs nothing and survives restarts.
3. The owner approves, denies, or edits the arguments, in the PWA or from a push notification. From Phase 2, high-risk categories require step-up authentication (passkey).
4. The run resumes from its persisted state and executes the call exactly once, guarded by its idempotency key.

### 6.3 Provider failover
1. The route resolves to an ordered candidate list, for example `[Claude Sonnet, GPT Sol, Gemini Flash]`.
2. Candidate 1 returns HTTP 429 with `retry-after: 30`. Health marks it as cooling down for 30 seconds.
3. Nothing was streamed yet, so the router moves to candidate 2 without the client noticing. If output had already started, the router emits a `reset` event (interactive runs only) and the UI replaces the partial message.
4. The ledger records both attempts. The dashboard shows candidate 1 as rate-limited.

### 6.4 Budget pressure
1. Daily spend crosses 80 %: an alert fires and the system switches to Economy mode (routine work forced to the fast tier, deferrable work postponed).
2. A hard limit is reached: background priority classes are refused admission and rescheduled to the next period. Interactive requests continue inside an interactive reserve. Past the reserve, the chat asks the owner whether to continue, downgrade, or stop.

### 6.5 Proactive event (Phase 3)
New email, then a rule-based prefilter (no model call), then fast-tier classification, then actions according to policy: record a free trial and schedule a reminder, notify if urgent, or start a run with a goal. Runs started from email content are tainted, so any outward action in them needs approval.

### 6.6 Device action (Phase 4)
The agent calls `desktop.click`. The Policy Gate decides. The Device Hub sends a signed command over the device's WebSocket. The desktop agent checks its local policy, shows its "Feroxes is in control" overlay, executes, and returns a result (plus a screenshot when asked). The audit log records it.

## 7. Memory architecture

### 7.1 Layers

| Layer | Holds | Stored as | Lifetime | How it reaches the prompt |
|---|---|---|---|---|
| Working (short-term) | Current turn, recent messages, run scratchpad, rolling session summary | `messages`, `sessions`, `agent_steps` | The session | Always, within a token budget |
| Episodic | What happened: conversation summaries, actions and outcomes, notable events; day, week and month digests | `memories` with `layer = episodic` | Permanent | Retrieved by relevance and time |
| Semantic | Facts, preferences, relationships, goals; the entity graph (people, orgs, projects, places, accounts) | `memories` with `layer = semantic`, plus `entities` and `relations` | Permanent, with validity intervals | Core block plus retrieval |
| Procedural | Standing rules, how-tos and workflows, communication style, learned action sequences | `memories` with `layer = procedural` | Permanent, versioned | Rules always; procedures when the task matches |

The **core memory block** is a compact profile (default cap 1,200 tokens) that is always in the prompt: who the owner is, key people, current focus, preferences, standing rules. It is generated from pinned and high-importance memories. The owner edits the memories behind it, or adds free-form notes that regeneration never overwrites.

### 7.2 Write path
1. **Capture.** Every message and event is stored raw and append-only.
2. **Extract.** A fast-tier model reads new turns and returns candidate memories as structured JSON: layer, kind, one atomic statement in canonical third-person form, entities, importance, confidence, whether the owner asserted it or it was inferred, validity start, and source message ids. Extraction is debounced (every few minutes or every N messages) to save tokens; "remember that ..." is handled immediately.
3. **Reconcile.** Each candidate is compared with similar existing memories (vector plus entity match). Outcome: add; update (merge); supersede (the old memory gets `valid_to` and a link to the new one); or no-op (adds evidence and raises confidence). Fixed rules sit on top of the model's judgment: an owner-asserted memory is never overridden by an inferred one, and contradictions never silently overwrite.
4. **Index.** Embedding (cached by content hash), full-text vector, entity links.

Credentials and other secrets are detected and excluded from extraction. The encrypted vault is the only place secrets live.

### 7.3 Consolidation (scheduled, non-destructive, budgeted)

| When | Job |
|---|---|
| Session idle for 30 min | Summarize the session into a conversation episode; final extraction sweep |
| Nightly | Daily digest episode; merge near-duplicates (high cosine similarity and same entity, confirmed by the model; originals marked `merged`); recompute importance with decay; refresh entity summaries; regenerate the core block; propose procedures from repeated requests |
| Weekly and monthly | Roll digests up into weekly and monthly episodes |

Consolidation creates new rows and links (`derived_from`, `part_of`). It never deletes sources, and retrieval can drill down from a monthly digest to the original messages.

### 7.4 Read path (hybrid retrieval)
1. Optional query rewrite when the message depends on earlier context ("send that to her"). Fast tier, and only when heuristics detect unresolved references.
2. Three retrievers in parallel: vector kNN (pgvector HNSW), full-text (Postgres `websearch_to_tsquery`), entity match (names and aliases via `pg_trgm`).
3. Reciprocal Rank Fusion, then re-weighting by importance, recency decay (the half-life depends on the kind: events fade over weeks, facts over years, pinned items never) and confidence.
4. Filters: active and currently valid (unless the question is historical), and a sensitivity level the chosen provider is allowed to receive.
5. Diversity (MMR) and packing into the section's token budget. Each memory is labeled with its id, so answers can cite it and the UI can show which memories were used.

The agent also has memory tools (`memory.search`, `memory.save`, `memory.update`, `memory.forget`), so it can manage memory deliberately, in addition to automatic extraction.

### 7.5 Owner control, and "never lose important information"
- Raw messages and events are append-only. Everything derived from them can be rebuilt.
- Every change to a memory is an event with before and after snapshots, the actor (owner, agent, extractor, consolidator) and a reason. Any change can be undone.
- Owner actions: view, search (with score explanations), edit, pin, mark sensitive, archive (hidden from retrieval but kept), delete permanently. Permanent deletion removes content, embeddings and derived summaries, and can add a **suppression rule** so the same fact isn't re-learned from old conversations.
- A nightly integrity job checks that every active memory has an embedding in the active embedding space, that full-text vectors are current, and that there are no orphans.
- Backups: a nightly encrypted database dump, plus a weekly human-readable JSONL export of all memories (§15.4).

### 7.6 Context assembly and prompt caching
Prompts are assembled in a fixed order so providers can cache the stable part:

```
[1] system instructions, persona, safety rules     static              (cache breakpoint)
[2] tool schemas for the active toolsets           static per toolset
[3] core memory block and standing rules           changes at most daily (cache breakpoint)
[4] rolling session summary                        changes at compaction
[5] earlier turns, verbatim and immutable          append-only between compactions
[6] latest user message + <context> retrieved memories for this turn </context>
```

Retrieved memories travel with the latest message instead of sitting in the system prompt, so the prefix [1]–[5] stays byte-identical from turn to turn and cache hits stay high. When the conversation outgrows its budget, the oldest turns are folded into the session summary: one cache miss, then stable again. Each route has an input-token target (for example 12k tokens for fast-tier chat). A large context window is a ceiling, not a target.

### 7.7 Sensitivity labels
Memories carry `normal`, `private` or `secret`. Each provider has a maximum sensitivity it may receive (for example: cloud providers up to `private`, a local Ollama model up to `secret`). The Context Builder filters by the chosen provider's limit. If failover moves a request to a provider with a lower limit, the context is rebuilt for that provider.

## 8. Intelligence layer and cost control

### 8.1 Concepts

| Concept | Meaning |
|---|---|
| Provider | A configured endpoint with credentials and an adapter kind: `openai`, `anthropic`, `google`, `openai-compatible` (OpenRouter, Groq, DeepSeek, Mistral, xAI, Together, LM Studio, vLLM, Ollama, ...) or `custom`. Several instances of one kind are allowed (two OpenAI keys, for example) |
| Model | A model offered by a provider, with capabilities (tools, vision, structured output, reasoning, prompt caching, computer use), context window, max output, price history, latency class and tier |
| Tier | `frontier`, `balanced`, `fast`, `local`. Each tier is an ordered list of models that the owner controls |
| Route | A named purpose (`chat.turn`, `agent.plan`, `memory.extract`, `memory.consolidate`, `classify`, `summarize`, `vision.describe`, `embed`, ...) with a tier policy, required capabilities and output limits |
| Priority class | `interactive` (owner is waiting) > `important` (time-sensitive background work, such as urgent email triage) > `routine` (extraction, consolidation) > `deferrable` (can wait hours; candidate for batch APIs) |

No code outside the Intelligence Layer names a model. Code names a route and a priority; configuration decides the model. Adding a provider that speaks the OpenAI API needs no code at all: base URL, key, model list.

### 8.2 Routing
1. **Resolve the tier.** Routes with `tier: auto` (chat) use a complexity classifier: cheap heuristics first (length, code, multi-step verbs, attachments, an explicit "think hard"), and a fast-tier classification only when the heuristics are unsure. Escalation follows failure signals (two invalid tool calls, an owner thumbs-down, "try harder") and stays in place for the rest of that task.
2. **Build candidates.** The tier's ordered list, filtered by capability, context window (against estimated tokens), sensitivity limit, health, and budget. A tier can list the same model through two providers, for example Claude through Anthropic and through OpenRouter. Each route has its own rate limits and quota, so this is the cheapest protection against one provider's throttling.
3. **Attempt in order** with per-attempt and time-to-first-token timeouts. Background requests may retry the same cheap model with backoff before failing over, and they **never escalate to a more expensive tier unless the route allows it**; they defer instead. An outage at the cheap provider therefore can't silently multiply background costs.

### 8.3 Failure handling

| Error class | Typical signal | Router response |
|---|---|---|
| `rate_limited` | 429, rate-limit headers | Cool down for `retry-after` (or exponential backoff), try the next candidate |
| `overloaded` | 503, 529 | Short cooldown, next candidate |
| `server_error`, `timeout`, `network` | 5xx, timeouts, connection resets | Count toward the circuit breaker, next candidate |
| `quota_exhausted` | 402, `insufficient_quota` | Disable the provider until its reset or owner action; alert |
| `auth_error` | 401, 403 | Disable the provider; alert (key revoked or expired) |
| `context_too_long` | 400 with a context-length error | Retry on a candidate with a larger window, or compact and retry |
| `invalid_request`, `content_filtered` | other 4xx | No blind failover; surface the error to the run |

Circuit breaker per provider and model: opens after 5 consecutive failures, or at 50 % errors or more over at least 10 calls within a minute; half-opens after a cooldown that doubles up to 10 minutes. The router also reads providers' rate-limit headers (remaining requests and tokens) and slows background traffic when headroom is low, so interactive calls keep capacity.

### 8.4 Token and cost management
- **Ledger.** Every metered call writes one usage event: provider, model, route, task type, priority, run/session/job ids, input, output, cached, cache-write and reasoning tokens (or characters and seconds for voice), cost computed from the price valid at call time, latency, time to first token, outcome, attempt number. Failed attempts are recorded too, because they can cost money.
- **Pricing.** Prices are data with effective dates, including cached-input rates, context-length tiers and batch discounts. Historical costs never change when prices change.
- **Estimation.** Before a call: input tokens from a tokenizer (OpenAI family) or a per-model characters-per-token ratio calibrated against actual usage; output is the p95 of past outputs on that route, capped by the max output setting. A safety factor covers the estimation error.
- **Budgets.** Scope (global, provider, route, priority class) × period (day, week, month, in the owner's timezone) × limit (USD and/or tokens), with soft thresholds (default 50, 80, 95 %) and a hard action (`downgrade`, `defer`, `ask`, `block`). A global budget can hold an **interactive reserve** that background work can't spend.
- **Reservations.** Each call reserves its estimate on every applicable budget in one transaction before it starts, and settles to the actual cost afterwards. Concurrent background jobs can't overshoot a limit by more than what is already in flight.
- **Power modes.** `normal`; `economy` (fast tier for all background work, frontier only on explicit request, deferrable work batched to the night); `background_paused` (no background model calls; model-free monitors keep running). Modes change manually or by budget policy. Separately, the system state is `running` or `stopped` (the kill switch, §9.4), which overrides every mode.
- **Cost reduction built in.** Cache-friendly prompt layout plus provider prompt caching; a response cache for deterministic tasks (same content hash, same classification); an embedding cache; toolset pruning; tool-output truncation; debounced extraction; batch APIs for deferrable work (Phase 2); local models for routine work when the owner has the hardware.
- **Visibility and alerts.** A dashboard with spend against budgets, burn-down and end-of-period projection, breakdowns by provider, model, route and priority, cache hit rate, failovers, provider health, and the most expensive runs. Alerts fire on thresholds, on spend-rate anomalies (for example, the last hour above 3× the trailing average, which also switches to Economy), and on provider auth or quota failures.

## 9. Safety and control model

### 9.1 Risk categories and defaults

| Category | Examples | Default in the "Assistant" preset |
|---|---|---|
| `read` | Search memory, read email, list files, take a screenshot | allow |
| `internal_write` | Save a memory, create an internal task, write a draft | allow (logged) |
| `external_write` | Label or archive an email, create a calendar event | notify or ask, by preset |
| `communicate` | Send an email or message, post a comment | ask |
| `destructive` | Delete files or emails, overwrite, force-push | ask, with a preview |
| `device_control` | Mouse and keyboard, shell commands, app control | ask (grant can cover one task) |
| `financial` | Purchases, payments, subscriptions | always ask, with step-up auth |
| `security` | Credentials, permissions, Feroxes's own policy | always ask, with step-up auth |

### 9.2 Autonomy presets
`Observer` (read-only, suggests), `Assistant` (default), `Delegate` (routine external writes happen automatically, with a notification), `Autopilot` (most actions automatic; asks only for hard-floor categories). A preset fills the permission matrix; per-tool and per-account overrides refine it. Conditional rules (recipient, path, amount, time of day) arrive in Phase 2.

**Hard floor.** `financial`, `security`, bulk memory deletion, and any outward action inside a tainted run always require approval. The agent has no tool that changes permissions. Policy changes happen only in Settings and need step-up authentication.

**Learning that raises autonomy asks first.** When the owner has approved the same kind of action many times, Feroxes may *suggest* a rule ("auto-archive newsletters?"). It never grants itself the permission.

### 9.3 Taint tracking (prompt-injection containment)
A run's taint set records every untrusted source that entered its context: an email from someone, a web page, a message from another person, a document. In a tainted run, every `external_write`, `communicate`, `destructive` and `device_control` call is escalated to `ask`, and the approval card shows which content came before the action. Untrusted content is wrapped in delimiters, and the system prompt tells the model it is data. This does not make injection impossible. It turns a successful injection into an approval prompt the owner sees, instead of an action.

### 9.4 Kill switch

| Control | Effect |
|---|---|
| Pause background | Power mode `background_paused`. Chat keeps working |
| **STOP** | Aborts every in-flight run and model stream (AbortSignal), stops job intake, makes the Policy Gate deny every tool call, tells device agents to halt and release input. The state is persisted, so the Core restarts in `stopped`. Only the authenticated owner can resume |

Triggers: the always-visible button in the PWA, the API and CLI, a desktop global hotkey and an Android notification action (Phase 4), and the voice command "Feroxes, stop" (Phase 2). Device agents also enforce a local stop that works when the Core is unreachable.

### 9.5 Audit log
An append-only table records every policy decision and outcome: actor, action, category, arguments with secrets redacted, decision, approval, result summary, cost, run and tool-call ids. Each row stores the hash of the previous row (a hash chain). A database trigger rejects `UPDATE` and `DELETE` for the application role, and a verification command walks the chain to detect tampering. From Phase 2, the daily chain head is anchored outside the database (in the encrypted backup manifest and an email to the owner), so rewriting the whole chain is also detectable.

### 9.6 Secrets and authentication
- Provider keys and OAuth tokens live in an encrypted vault table (AES-256-GCM, master key from a Docker secret or the OS keyring, key versions for rotation). Secrets never enter prompts or logs; log output passes a redaction filter.
- Owner login: password (argon2id) with optional TOTP in Phase 1; passkeys and step-up authentication for critical approvals in Phase 2. Session cookies are `__Host-` prefixed, `HttpOnly`, `Secure`, `SameSite=Strict`; state-changing requests also require a custom header.
- Devices authenticate with per-device credentials created at pairing (one-time code shown in the PWA), and can be revoked one by one.

## 10. Device control architecture (Phase 4)

**Protocol.** JSON messages over WebSocket (JSON-RPC 2.0 style), defined once as Zod schemas in `@feroxes/protocol` and exported as JSON Schema. The Rust and Kotlin agents generate their types from that schema. Core to device: `action.execute {id, action, params, timeoutMs}`, `halt`. Device to core: `action.result`, `event` (screen changed, notification received, user activity), `heartbeat`, `capabilities`.

**Desktop agent (Windows and macOS, Tauri 2 + Rust).**
- Perception: screenshots (screen, window, region; downscaled before upload to save tokens) and the accessibility tree (Windows UI Automation, macOS AX API) rendered as compact text. The tree is far cheaper for the model than pixels and is the first choice; screenshots and vision models are the fallback.
- Action, two modes:
  - *Background* (behind the screen): accessibility actions on controls (Invoke, SetValue), OS scripting (PowerShell/COM, AppleScript/JXA), CLI and headless browser. Doesn't move the owner's cursor, so it can run while the owner works. Preferred whenever possible.
  - *Visible*: synthesized mouse and keyboard. Shows a "Feroxes is in control" overlay with a stop button, and pauses automatically when it detects owner input, so the agent and the owner never fight over the cursor.
- Files (inside allowed roots), apps and windows (list, focus, launch, close), clipboard, shell (allowlist or approval), notifications, microphone for push-to-talk, speakers for proactive speech.
- Local safety: its own allowlist, a global kill hotkey, and refusal of any command when the local stop is engaged.
- Platform notes: macOS needs the Accessibility and Screen Recording permissions. On Windows, controlling elevated windows requires the agent itself to run elevated (UIPI), so the default is non-elevated with elevation as an explicit opt-in.

**Android agent (Kotlin).**
- `AccessibilityService`: read the UI tree, click nodes, set text, gestures, global actions (back, home, recents, notifications), and screenshots via `takeScreenshot` on Android 11+.
- `NotificationListenerService`: read incoming notifications, including messaging apps, and reply through the notification's own inline-reply action. This is the basis of the WhatsApp bridge (§11.3).
- A foreground service keeps the Core connection alive; the app asks for exemption from battery optimization.
- Distribution: sideloaded, since Play policy restricts Accessibility use. Google is rolling out Android developer verification, starting 2026-09-30 in Brazil, Indonesia, Singapore and Thailand ([Android developers](https://developer.android.com/developer-verification/guides)), and installing through ADB remains possible for unverified apps ([Google support thread](https://support.google.com/android/thread/417615700/installing-unverified-apks-after-2026-2027-is-this-allowed-if-you-use-termux?hl=en)). Plan: ADB install, or register a developer account if the owner prefers normal installs.

**Computer-use loop.** Perceive (tree first, screenshot if needed), let a vision-capable model choose one action, execute, verify the result, repeat. Each action passes the Policy Gate; a device-control grant can cover one task so the owner isn't asked at every click.

## 11. Integrations architecture (Phase 3)

### 11.1 Connector SDK
A connector declares: auth method (OAuth2, API key, bot token, QR/pairing), support for several accounts, tools (with risk metadata), triggers (new email, calendar reminder, PR review requested), an optional sync with cursors, and a health check. A shared OAuth manager stores tokens in the vault and refreshes them. Connectors poll by default, because push webhooks would need public endpoints.

### 11.2 Planned connectors

| Service | Approach |
|---|---|
| Gmail, Google Calendar | Google APIs with the owner's own OAuth client. The client must be published "In production": with the "Testing" status, consent and refresh tokens expire after seven days ([Google Cloud help](https://support.google.com/cloud/answer/15549945)). IMAP with an app password is the fallback |
| Outlook, Microsoft Calendar | Microsoft Graph with MSAL, personal accounts supported |
| Any other mailbox | IMAP and SMTP |
| Subscriptions and free trials | Email classifier extracts service, plan, trial end, amount, renewal date and cancellation link into a `subscriptions` table, with reminders N days before a trial converts |
| GitHub | Fine-grained token or GitHub App; notifications, PRs, issues, repositories |
| Discord | A bot account the owner creates and invites to their servers; it can DM the owner. Automating a normal user account ("self-bot") is forbidden by Discord and can get the account terminated ([Discord support](https://support.discord.com/hc/en-us/articles/115002192352)), so Feroxes won't do it |
| WhatsApp | See §11.3 |
| Browser | Playwright on the Core host with persistent profiles, and later attach to the owner's own browser through the desktop agent |
| Tasks | Internal task store first; optional sync to an external task app |
| Anything with an MCP server | MCP client (spec revision 2026-07-28, [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)); imported tools default to `ask` until the owner sets their level |

### 11.3 WhatsApp
WhatsApp offers no official API for personal accounts. Unofficial libraries such as Baileys and whatsapp-web.js violate WhatsApp's terms and accounts using them can be banned ([Square Cloud overview](https://squarecloud.app/en/learning/bots/baileys-vs-whatsapp-web-js-vs-cloud-api)). Feroxes therefore uses, in order of preference:
1. **Android notification bridge (default).** Read incoming messages from notifications on the owner's own phone and reply through the notification's inline-reply action, the same mechanism smartwatches use. Works with the official app; no extra client is logged in.
2. **WhatsApp Business Cloud API**, if the owner has a business number.
3. **Unofficial backend (opt-in only)**, behind an explicit warning about the ban risk.

## 12. Voice architecture (Phase 2)
- **TTS:** ElevenLabs. `eleven_flash_v2_5` for conversational replies (low latency, WebSocket streaming) and `eleven_v4_turbo` for expressive briefings ([ElevenLabs model guide](https://elevenlabs.io/docs/pt/eleven-api/choosing-the-right-model)). The TTS WebSocket does not support the v3 family; expressive models use HTTP streaming or the Text-to-Dialogue WebSocket ([ElevenLabs docs](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets)).
- **STT:** ElevenLabs Scribe v2 Realtime, about 150 ms latency ([ElevenLabs](https://elevenlabs.io/realtime-speech-to-text-api)), behind an interface that also fits Whisper-class or local engines.
- **Input sources:** push-to-talk in the PWA first (hold to talk, streamed over WebSocket), then the desktop hotkey and an Android quick-settings tile. The input abstraction has a `trigger` field (`ptt`, `wakeword`, `vad`), so a wake-word engine (openWakeWord or Porcupine on a device agent) plugs in later without changing the pipeline.
- **Output routing:** replies speak where the owner spoke. Proactive speech goes to the device the owner is most likely at, respects quiet hours and calendar busy times, and stops immediately when the owner starts talking (barge-in).
- **Metering:** characters and seconds go into the same ledger and budgets as tokens.

## 13. Proactive engine (Phase 3)
- **Monitors** poll connectors and produce events (new email, calendar event soon, trial ending, PR review requested, device notification).
- **Triggers and rules** map events to reactions: notify, add to a briefing, or start a run with a goal. Rule conditions are evaluated without a model whenever possible; models are used for classification and for the run itself.
- **Briefings:** morning and evening summaries (calendar, important email, deadlines, trials, open approvals, spend), delivered as text, push notification or speech.
- **Initiative levels** per rule: `inform` (tell me), `suggest` (one-tap approve), `act` (do it within my permission levels and report).
- **Noise control:** quiet hours, urgency levels, batching into digests, and a weekly report of which notifications the owner ignored, which feeds back into thresholds.
- **Cost:** every monitor declares its priority class, so budget pressure pauses the least important work first.

## 14. User interface
The PWA (Next.js, Tailwind, shadcn/ui) has: chat with streaming, tool-call cards, inline approval cards, "memories used" chips and a per-message cost/model badge; a dashboard (system state and kill switch, spend against budget, provider health, active runs, devices, connected accounts, recent memories, alerts); a memory browser; usage and budgets; activity (runs and the audit log); an approvals inbox; settings (providers and routing, budgets and modes, permissions, voice, automations, integrations, devices, backups, security). It is responsive from the start, installable, and gets web push in Phase 2. A STOP control is visible on every screen.

## 15. Reliability, security and operations

### 15.1 Running 24/7
- Container restart policies (or systemd/launchd on bare metal), `/healthz` and `/readyz`, graceful shutdown that drains runs and persists state.
- An external dead-man's switch: the Core pings a heartbeat service every few minutes. If the pings stop, the owner is alerted by that service, which still works when the Core host is down.
- Crash recovery: at boot, runs still marked `running` become `interrupted`. Background runs resume automatically when their pending step is idempotent; interactive runs ask the owner.
- Idempotency: tool calls carry `runId:stepIndex:callIndex` keys, and connectors record external ids (sent message ids, created event ids), so a retry never sends an email twice.

### 15.2 Observability
Structured JSON logs (pino) with redaction; a per-run timeline in the UI built from the database (steps, model calls, tool calls, costs, timings); OpenTelemetry traces (run, step, model call, tool call) exportable to any OTel backend, including LLM-focused ones such as Langfuse.

### 15.3 Network and input hygiene
- Tailnet only; host allowlist; CSRF protection; rate limits on auth.
- Tool arguments are validated with Zod; nothing the model writes is evaluated as code.
- `web.fetch` blocks private, loopback, link-local and tailnet address ranges (SSRF protection; the Core sits on a home network), pins resolved IPs, and caps size and time.
- File tools are confined to allowed roots and resolve symlinks before checking paths.

### 15.4 Backups
Nightly `pg_dump` encrypted with [age](https://age-encryption.org) to the owner's public key. The Core can write backups but cannot read them; restoring needs the owner's private key, kept offline. Retention: 7 daily, 4 weekly, 12 monthly. A weekly JSONL export of memories, also encrypted. Local volume first, S3-compatible offsite storage in Phase 2. A `backup:verify` command restores the latest backup into a scratch database and compares checksums.

### 15.5 Testing strategy
Unit tests (Vitest); integration tests against real Postgres with pgvector (Testcontainers); a scripted mock provider for deterministic agent tests and for injecting 429s, 5xx, timeouts and mid-stream failures; a memory retrieval evaluation set; Playwright end-to-end tests for the UI; a 24-hour soak test before each phase is closed.

## 16. Extensibility summary

| To add | Do this |
|---|---|
| An OpenAI-compatible provider | Settings: base URL, key, sync models. No code |
| A provider with its own API | Implement `ProviderAdapter` (stream, embed, list models, classify errors) |
| A tool | `defineTool({ name, description, input, risk, execute })` |
| A service | `defineConnector({ auth, accounts, tools, triggers, sync, health })` |
| Tools from the MCP ecosystem | Add the MCP server in Settings; set permission levels for its tools |
| A device type | Implement the device protocol from the published JSON Schema |
| A voice engine | Implement `SpeechToText` or `TextToSpeech` |

## 17. Key design decisions

| # | Decision | Alternatives considered | Why |
|---|---|---|---|
| D1 | Always-on Core plus thin device agents (hub-and-spoke) | One desktop app that does everything | 24/7 operation needs a host that never sleeps; device agents stay small, auditable and replaceable |
| D2 | TypeScript for Core and UI, Rust for the desktop agent, Kotlin for the Android agent | Python core; Electron agent | Each language is the native choice for its platform; the contracts between them are generated from one schema |
| D3 | PostgreSQL for everything: state, vectors, full-text, jobs, ledger, audit | Redis + a vector database + a queue | One system to back up, monitor and restore; memory rows and their vectors change in the same transaction |
| D4 | Own router and budget ledger; AI SDK only normalizes provider APIs | LiteLLM proxy; OpenRouter only; a framework's agent loop | Budgets per task type and priority, pausing background work, and sensitivity-aware routing are core features, not add-ons |
| D5 | Runs are owned by the server; clients observe them over SSE | Request-scoped streaming (`useChat` style) | Runs outlive browser tabs: approvals can wait hours, background runs have no client, several devices watch the same run |
| D6 | One `memories` table with layers, validity intervals and an event history | A separate store per layer; an external memory service | One retrieval path, one history mechanism, one UI; contradictions become superseded versions instead of overwrites |
| D7 | Policy Gate inside the Tool Runtime, plus taint tracking | Checks inside each tool; prompt-only guardrails | A single choke point can't be skipped by a new tool, and taint turns prompt injection into an approval prompt |
| D8 | MCP-compatible tool layer | Native connectors only | Existing MCP servers become usable under the same policy gate |
| D9 | Private network (Tailscale), no public ports | Public HTTPS with login | Removes the internet-facing attack surface of a system that can control your devices |
| D10 | Persist every agent step (resumable runs) | Temporal, DBOS | Restart safety without another runtime; revisit if multi-day workflows become common |
| D11 | Integrations before device control in the roadmap | Device control right after Phase 1 | Official APIs deliver daily value at lower risk, and the policy engine gets real use before it guards mouse and keyboard |

## 18. Constraints the owner should know about
- **WhatsApp, Discord:** no sanctioned way to automate a personal account; see §11.2 and §11.3 for what Feroxes does instead.
- **Google OAuth:** publish your OAuth client "In production" to avoid weekly re-consent.
- **Android:** the agent is sideloaded; developer verification is rolling out by country.
- **Local models:** useful for routine and `secret` work only with a capable GPU; otherwise the fast cloud tier is cheaper per unit of quality.
- **Cost floor:** 24/7 background work has a baseline cost. With fast-tier routing it is small (an estimate is in the Phase 1 plan, §9.3); interactive use on the higher tiers is where most of the budget goes.
