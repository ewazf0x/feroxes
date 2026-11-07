# Feroxes

A personal AI operating system for one owner. It keeps a long-term memory, spreads work across several AI providers within a budget, acts on the owner's devices and accounts, speaks and listens, and runs 24/7. The owner stays in control of every action.

> **Status (2026-11-07):** Phase 1 core logic is implemented and tested (90 tests, all passing): router with failover, cost ledger and budgets, policy gate with approvals and audit chain, memory engine, agent runtime. Storage is in-memory for now; Postgres, the HTTP API and the web UI are next. See [Phase 1 status](docs/04-phase-1-plan.md#14-implementation-status).

## Try it

Requires Node.js 24.7 or newer (26 LTS recommended). The only runtime dependency is Zod.

```bash
pnpm install

# End-to-end demo with mock providers: memory, failover, approvals, kill switch, ledger, audit. No keys needed.
node apps/core/src/cli.ts demo

# Chat with your real providers (any of ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY)
cp .env.example .env   # fill in your keys
node --env-file=.env apps/core/src/cli.ts chat

# Checks
pnpm run typecheck
pnpm test
```

Inside `chat`: `/usage`, `/budget`, `/memories`, `/mode economy`, `/stop`, `/resume`, `/quit`. Risky actions ask for approval inline.

## Documents

| Doc | Contents |
|---|---|
| [01 Architecture](docs/01-architecture.md) | System overview, components, key flows, memory, router and cost control, safety model, devices, integrations, voice, operations, design decisions |
| [02 Tech stack](docs/02-tech-stack.md) | Chosen technologies with current versions, reasons, and alternatives considered |
| [03 Project structure](docs/03-project-structure.md) | Monorepo layout, package boundaries, dependency rules, conventions |
| [04 Phase 1 plan](docs/04-phase-1-plan.md) | Foundation plan and the current implementation status |
| [05 Roadmap](docs/05-roadmap.md) | Phases 2 to 6 and a requirement-to-phase traceability matrix |

## Code map

| Package | What it does |
|---|---|
| `packages/shared` | Ids (UUIDv7), money in nano-dollars, hashing, event bus, logger with redaction, time zones |
| `packages/metering` | Prices with effective dates, usage ledger, budgets with atomic reservations, power modes, admission control, spend anomaly detection |
| `packages/llm` | Model router (tiers, failover, circuit breakers, rate-limit headroom), cost estimator, complexity classifier, adapters for OpenAI, OpenAI-compatible (OpenRouter, Ollama), Anthropic, Gemini, and a scripted mock |
| `packages/policy` | Autonomy presets, hard floor, taint escalation, kill switch, approvals, hash-chained audit log |
| `packages/tools` | Tool SDK, the Tool Runtime (the single gate for side effects), sandboxed files, SSRF-safe web fetch, time, plan, notify |
| `packages/memory` | Memory store, hybrid retrieval, extraction and reconciliation, supersede/evidence/undo, suppression, consolidation, export |
| `packages/agent` | Agent runtime: persisted runs and steps, tool loop, approvals across restarts, cache-friendly context, memory tools |
| `apps/core` | Composition root, provider catalog, vault, CLI |

## System at a glance

```
 Owner ── PWA (desktop + mobile) · push-to-talk · notifications
   │  HTTPS (REST + SSE), private network (Tailscale)
   ▼
 Feroxes Core (always-on host: Oracle Cloud ARM VM)
   Agent Runtime · Memory Engine · Intelligence Layer (router) · Metering (budgets)
   Tool Runtime · Policy Engine (approvals, audit, kill switch) · Scheduler
   Connectors · Device Hub · Voice
   PostgreSQL 18 + pgvector (state, memory, vectors, search, jobs, ledger, audit)
   │                         │                              │
   ▼                         ▼                              ▼
 Model providers        Device agents                  Owner's services
 (Anthropic, OpenAI,    (Desktop: Tauri/Rust,          (Gmail, Outlook, Calendar,
  Gemini, OpenRouter,    Android: Kotlin)               GitHub, Discord bot, ...)
  Ollama, ElevenLabs)
```

## Non-negotiables

- One owner. Feroxes never accesses other people's accounts or messages.
- Every outward action goes through the Policy Gate and lands in a hash-chained audit log.
- Every paid API call goes through the router and the budget ledger.
- Raw interactions are never deleted automatically. Only the owner deletes.
- One kill switch stops everything, including device agents.
