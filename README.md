# Feroxes

A personal AI operating system for one owner. It keeps a long-term memory, spreads work across several AI providers within a budget, acts on the owner's devices and accounts, speaks and listens, and runs 24/7. The owner stays in control of every action.

> Status: architecture and Phase 1 plan ready for review. No code yet.

## Documents

| Doc | Contents |
|---|---|
| [01 Architecture](docs/01-architecture.md) | System overview, components, key flows, memory, router and cost control, safety model, devices, integrations, voice, operations, design decisions |
| [02 Tech stack](docs/02-tech-stack.md) | Chosen technologies with current versions, reasons, and alternatives considered |
| [03 Project structure](docs/03-project-structure.md) | Monorepo layout, package boundaries, dependency rules, conventions |
| [04 Phase 1 plan](docs/04-phase-1-plan.md) | Foundation: memory, multi-API router, token and cost management, basic agent, policy gate, minimal UI |
| [05 Roadmap](docs/05-roadmap.md) | Phases 2 to 6 and a requirement-to-phase traceability matrix |

## System at a glance

```
 Owner ── PWA (desktop + mobile) · push-to-talk · notifications
   │  HTTPS (REST + SSE), private network (Tailscale)
   ▼
 Feroxes Core (always-on host)
   Agent Runtime · Memory Engine · Intelligence Layer (router) · Metering (budgets)
   Tool Runtime · Policy Engine (approvals, audit, kill switch) · Scheduler
   Connectors · Device Hub · Voice
   PostgreSQL 18 + pgvector (state, memory, vectors, search, jobs, ledger, audit)
   │                         │                              │
   ▼                         ▼                              ▼
 Model providers        Device agents                  Owner's services
 (OpenAI, Anthropic,    (Desktop: Tauri/Rust,          (Gmail, Outlook, Calendar,
  Google, compatible,    Android: Kotlin)               GitHub, Discord bot, ...)
  local, ElevenLabs)
```

## Non-negotiables

- One owner. Feroxes never accesses other people's accounts or messages.
- Every outward action goes through the Policy Gate and lands in a hash-chained audit log.
- Every paid API call goes through the router and the budget ledger.
- Raw interactions are never deleted automatically. Only the owner deletes.
- One kill switch stops everything, including device agents.
