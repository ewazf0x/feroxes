# Feroxes

A personal AI agent for one owner that runs on the owner's own PC. It keeps a long-term memory and a stable identity, spreads work across several AI providers within a budget, controls the owner's PC and Android phone, speaks and listens, works on the owner's goals in the background, and explains everything it does. The owner stays in control of every action.

> **Status (2026-11-08):** the Core is implemented and tested (137 tests, all passing): model routing with failover, budgets, the policy gate and audit log, memory, the agent, SQLite storage that survives restarts, the device hub with PC and phone tools, the voice pipeline, the brain layer (self-model, goals, debate, situation awareness, reflection, briefings), and Kiro as the main brain. The **PC app** is built: a premium web UI (`apps/desktop/ui`), a local API (`apps/core` `serve`), and a native **Tauri 2** shell (`apps/desktop/src-tauri`) that launches the Core and connects to it. The Core-side packaging is verified end to end; the Rust shell is compiled and bundled into installers by the **Desktop** CI workflow. See [08 — Desktop app](docs/08-desktop-app.md). The Android app is next; see [Revision 2](docs/06-revision-pc-apps-brain.md).

## Try it

Requires Node.js 24.7 or newer (26 LTS recommended). The only runtime dependency is Zod.

```bash
pnpm install

# End-to-end demo: memory across a restart, PC control with an approval, "why did you do that?",
# voice, goals and a briefing, STOP, ledger and audit. Scripted providers and a simulated PC; no keys needed.
node apps/core/src/cli.ts demo

# Real use: put your keys in .env (Anthropic, OpenAI, Gemini, OpenRouter, ElevenLabs), then
node --env-file=.env apps/core/src/cli.ts chat

pnpm run typecheck && pnpm test
```

### The PC app

```bash
# Run the Core as a local service (the window connects to it; also opens in a browser at the URL)
pnpm run serve

# Build the native desktop installer (.dmg / .msi / .AppImage). Needs Rust + the Tauri OS deps.
pnpm run desktop:build
```

See [08 — Desktop app](docs/08-desktop-app.md) for the architecture, the 24/7 background Core, and
how CI builds installers for macOS, Windows and Linux.

In `chat`: `/goals`, `/goal <title>`, `/self`, `/why`, `/briefing`, `/reflect`, `/growth`, `/devices`, `/pair`, `/usage`, `/budget`, `/memories`, `/mode economy`, `/stop`, `/resume`. Risky actions ask inline; device actions can be allowed for the whole task. Data is saved in `./data/feroxes.db`.

## Documents

| Doc | Contents |
|---|---|
| [09 Status](docs/09-status.md) | **What is implemented, what is verified, what still needs your credentials or hardware** |
| [08 Desktop app](docs/08-desktop-app.md) | **The PC app:** Tauri shell, attach-or-spawn the Core, self-contained packaging, the 24/7 background Core, building installers |
| [07 Kiro as the brain](docs/07-kiro-brain.md) | Kiro as the main reasoning engine, with API models as fallback |
| [06 Revision 2](docs/06-revision-pc-apps-brain.md) | **Current decisions:** PC-hosted Core with SQLite, native apps, device control, voice, the brain layer, Kiro, status of every requested capability, new roadmap |
| [01 Architecture](docs/01-architecture.md) | Original system design (components, flows, memory, router, safety model) |
| [02 Tech stack](docs/02-tech-stack.md) | Technologies, versions and alternatives |
| [03 Project structure](docs/03-project-structure.md) | Package boundaries and conventions |
| [04 Phase 1 plan](docs/04-phase-1-plan.md) | Foundation plan, algorithms, data model, status |
| [05 Roadmap](docs/05-roadmap.md) | Original roadmap (replaced by 06 §10) |

## Code map

| Package | What it does |
|---|---|
| `packages/shared` | Ids, money in nano-dollars, hashing, event bus, logger with redaction, time zones |
| `packages/metering` | Prices, usage ledger, budgets with atomic reservations, power modes, admission control |
| `packages/llm` | Model router (tiers, failover, circuit breakers), cost estimator, adapters for OpenAI, OpenAI-compatible (OpenRouter, Ollama), Anthropic, Gemini |
| `packages/policy` | Autonomy presets, hard floor, taint, task grants, kill switch, approvals, hash-chained audit |
| `packages/tools` | Tool SDK and the Tool Runtime (the single gate for side effects), files, web fetch, time, plan, notify |
| `packages/memory` | Memory engine: hybrid retrieval, extraction, reconciliation, consolidation, export |
| `packages/agent` | Agent runtime: persisted runs, tool loop, approvals across restarts, context with images |
| `packages/store-sqlite` | All storage in one SQLite file: full-text search, vectors, append-only audit, backups |
| `packages/protocol` | Device protocol v1 and its JSON Schema for the Rust and Kotlin apps |
| `packages/devices` | Device hub: pairing, signed commands, STOP, owner-activity pause; PC and phone tools; `code.kiro`; simulator |
| `packages/voice` | ElevenLabs Scribe STT and Flash TTS, sentence streaming, push-to-talk, spoken STOP |
| `packages/brain` | Self-model, goals, skills, debate, situation awareness, owner state, reflection, briefings, explanations, scheduler |
| `apps/core` | Composition root, provider catalog, vault, CLI, demo, local API server (`serve`) |
| `packages/connectors` | Integrations framework (OAuth 2.0 + PKCE, sealed tokens, refresh, revocation, health, audit, policy-gated tools) and 12 official-API connectors |
| `apps/pc-agent` | The PC device agent: pairs with the Core, verifies signed commands, controls Windows (and Linux/macOS where tools exist) |
| `apps/desktop/ui` | The PC app's web UI: design tokens, a dependency-free reactive core, every screen including Integrations, command palette |
| `apps/desktop/src-tauri` | The native Tauri 2 shell that launches the Core and hosts the UI |

## Non-negotiables

- One owner. Feroxes never accesses other people's accounts or messages.
- Every outward action goes through the Policy Gate and lands in a hash-chained audit log.
- The agent proposes and the owner decides: goals, values, skills, improvements, permissions.
- Every paid call (models and voice) goes through the router or meter and the budget ledger.
- Raw interactions are never deleted automatically. Only the owner deletes.
- One STOP halts everything, including paired devices.
