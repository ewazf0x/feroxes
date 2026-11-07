# Feroxes: Recommended Tech Stack

> Versions reflect the ecosystem on 2026-11-07. Exact versions are pinned in the lockfile when the repo is scaffolded, and Renovate keeps them current.

## 1. Core platform

| Area | Choice | Why |
|---|---|---|
| Language (Core, UI, contracts) | **TypeScript 7** (native Go compiler) | GA on 2026-07-08 and about 10× faster than the JS-based compiler ([TypeScript blog](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)). One language for Core, UI and protocol schemas removes a whole class of contract drift |
| Runtime | **Node.js 26 LTS** ("Lithium") | Entered LTS on 2026-10-28, supported until the end of April 2029 ([Node.js release](https://nodejs.org/en/blog/release/v26.13.0)) |
| Monorepo | **pnpm workspaces + Turborepo** | pnpm's strict dependency isolation catches undeclared imports; Turborepo caches the task graph |
| HTTP server | **Fastify 5** | pino logging built in, encapsulated plugins (connectors can register routes in isolation), mature WebSocket, rate-limit, cookie and helmet plugins |
| Validation and schemas | **Zod 4** | One schema per contract gives runtime validation, TS types, and JSON Schema for tool definitions and the device protocol |
| Lint and format | **Oxlint** (type-aware) + **Oxfmt** | typescript-eslint depends on the TypeScript JS compiler API, which TS 7.0 doesn't ship ([Next.js discussion](https://github.com/vercel/next.js/discussions/81472)). Oxlint's type-aware engine is built on TS 7 and has been stable since July 2026 ([Oxc blog](https://oxc.rs/blog/2026-07-22-type-aware-linting-stable.html)). Oxfmt is Prettier-compatible ([Oxc docs](https://oxc.rs/docs/guide/usage/formatter)), so Prettier is a drop-in fallback |
| Tests | **Vitest**, **Testcontainers**, **Playwright** | Unit and integration tests, real Postgres + pgvector in tests, UI end-to-end |
| Build | `tsc -b` with project references; `tsx` for watch mode in dev | ESM only, `moduleResolution: nodenext` |

## 2. Data

| Area | Choice | Why |
|---|---|---|
| Database | **PostgreSQL 18** | Current stable. PostgreSQL 19 GA is planned for 2026-11-19 ([PostgreSQL news](https://www.postgresql.org/about/news/postgresql-19-rc-1-released-3409/)); upgrade once pgvector ships builds for it. Native `uuidv7()` gives time-ordered ids |
| Vectors | **pgvector ≥ 0.8.7** | HNSW indexes and iterative index scans for filtered queries. 0.8.7 fixes a buffer overflow in IVFFlat builds ([PostgreSQL news](https://www.postgresql.org/about/news/pgvector-087-released-3392/)), so that is the minimum |
| Full-text and fuzzy match | Built-in `tsvector` + `pg_trgm` | Keyword retrieval and entity alias matching without another service |
| ORM and migrations | **Drizzle ORM 1.x** + drizzle-kit | SQL-first, typed, pgvector column support, generated SQL migrations that we review before applying. v1 replaces the old relational query API with `defineRelations()` ([Drizzle docs](https://orm.drizzle.team/docs/upgrade-v1)); check at scaffold time whether 1.0 is final or still on the `rc` tag |
| Jobs and cron | **pg-boss 12** | Queues on Postgres using `SKIP LOCKED`, cron schedules, retries, singleton keys for debouncing, priorities ([pg-boss](https://github.com/timgit/pg-boss)). No Redis |

## 3. Intelligence layer

| Area | Choice | Why |
|---|---|---|
| Provider SDK layer | **Vercel AI SDK 6** provider packages: `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai-compatible` ([AI SDK 6](https://vercel.com/blog/ai-sdk-6)) | Maintained adapters that normalize streaming, tool calls and usage (including cached and reasoning tokens). Wrapped in Feroxes adapters and called with `maxRetries: 0` and a single step, because Feroxes owns retries, failover, tool execution, approvals and persistence. For the same reason we don't use the SDK's Agent abstraction |
| OpenAI-compatible endpoints | One adapter | Covers OpenRouter, Groq, DeepSeek, Mistral, xAI, Together, Fireworks, LM Studio, vLLM and Ollama |
| Token counting | `gpt-tokenizer` for OpenAI-family models; calibrated estimates for others | See Phase 1 plan §7.3 |
| MCP | Official TypeScript SDK, spec revision **2026-07-28** | That revision makes the protocol core stateless and removes protocol-level sessions from Streamable HTTP ([MCP changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)) |
| Embeddings | Configurable "embedding spaces" | Default hosted: OpenAI `text-embedding-3-small` (cheap, 1536 dims, still the common baseline per [Rework's 2026 comparison](https://resources.rework.com/tools/ai-data-infra/best-embedding-models-2026)). Alternatives: Gemini Embedding 2 (multimodal, Matryoshka dimensions). Local: Qwen3-Embedding or BGE-M3 through Ollama |

### 3.1 Model tiers (examples, October 2026 list prices per 1M tokens, input/output)

| Tier | Used for | Examples |
|---|---|---|
| frontier | Hard reasoning, planning, high-stakes writing | Claude Opus 5.5 ($4/$20), GPT-6 Astra ($10/$50) |
| balanced | Default chat and multi-step tool use | Claude Sonnet 5.5 ($2/$10), GPT-6.1 Sol ($2/$10), GPT-6.1 Terra ($1/$5), Gemini 3.x Flash ($0.75/$3.75, promotional) |
| fast | Extraction, classification, summaries, query rewriting | Claude Haiku 5.5 ($0.10/$0.50), GPT-6 Luna ($0.10/$0.50), Gemini Flash-Lite (from $0.10 input) |
| local | Zero marginal cost, `secret` data | Open models served by Ollama |

Sources: [IntuitionLabs on Claude pricing](https://intuitionlabs.ai/articles/claude-pricing-plans-api-costs), [IntuitionLabs on OpenAI pricing](https://intuitionlabs.ai/articles/chatgpt-api-pricing-2026-token-costs-limits), [Puter on GPT-6.1 Terra](https://developer.puter.com/tutorials/openai-api-pricing/), [Puter on Gemini](https://developer.puter.com/tutorials/gemini-api-pricing/). These are third-party summaries; the seed catalog is checked against each provider's own pricing page at implementation time. Google's current Flash prices are promotional and double on 2027-01-01 according to Puter, which is exactly why prices are stored with effective dates.

### 3.2 Providers configured for this owner (decision, 2026-11-07)

| Provider | Adapter | Notes |
|---|---|---|
| Anthropic (Claude) | `anthropic` | Prompt caching with explicit breakpoints |
| OpenAI | `openai` | Also the default embedding model |
| Google Gemini | `google` | On the free tier, Google may use prompts to improve its products; the paid tier doesn't ([Data Studios summary](https://www.datastudios.org/post/google-ai-studio-pricing-free-access-usage-limits-api-costs-and-production-billing-in-early-2026https:/www.datastudios.org/post/google-ai-studio-pricing-free-access-usage-limits-api-costs-and-production-billing-in-early-2026)). A free-tier key is therefore set to `max_sensitivity: normal`, so private memories never go to it; enabling billing lifts that |
| OpenRouter | `openai-compatible` | Second route to the same models. Prices are read from OpenRouter's model list |
| Ollama on the owner's PC (optional) | `openai-compatible` | `local` tier over Tailscale; health checks skip it while the PC is off. The Oracle VM has no GPU |

Sending the same model through two providers (for example Claude through Anthropic and through OpenRouter) gives separate rate limits and quotas. That is the cheapest protection against one provider throttling.

**Kiro is not usable as a provider.** Kiro's billing FAQ allows the subscription only in Kiro's own interfaces (IDE, CLI, Web, ACP clients, software-development automation) and forbids third-party harnesses that route requests outside them ([Kiro billing FAQ](https://kiro.dev/docs/billing/related-questions)). Kiro API keys only authenticate Kiro CLI in headless mode ([Kiro authentication docs](https://kiro.dev/docs/getting-started/authentication/)). Community gateways that expose Kiro as an OpenAI-style API break that rule and put the Kiro account at risk, so Feroxes won't ship one. A later, separate option to evaluate against the terms at that time: a coding tool that runs Kiro CLI headless on the owner's own repositories.

## 4. Web UI

| Area | Choice | Why |
|---|---|---|
| Framework | **Next.js 16** (App Router) + **React 19** | Current major, patch line 16.4.x ([release tracker](https://releasebot.io/updates/vercel/next-js)). Next.js 16.3 and later support the TS 7 compiler during `next build` ([Achromatic guide](https://www.achromatic.dev/blog/nextjs-16-3-typescript-7-upgrade)) |
| Styling and components | **Tailwind CSS v4** + **shadcn/ui** | New shadcn projects default to Base UI primitives since July 2026, with Radix still supported ([shadcn changelog](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default)). shadcn's AI Elements give a head start on chat, tool-call and approval components |
| Server state | **TanStack Query** | Caching, retries and invalidation driven by SSE events |
| Client state | **Zustand** | Small UI state (composer, panels, voice state) |
| Charts | Recharts through shadcn charts | Usage and budget dashboards |
| PWA | App Router `manifest.ts` + **Serwist** in configurator mode | Configurator mode doesn't depend on webpack internals, so it works with Turbopack ([Serwist docs](https://serwist.pages.dev/docs/next/config)) |
| Markdown and code | `react-markdown` + `shiki` | Rendering agent answers |

## 5. Security and operations

| Area | Choice |
|---|---|
| Password hashing | argon2id via Node's built-in `crypto.argon2` (available since Node 24.7), so there is no native addon to build for ARM |
| Passkeys and step-up auth (Phase 2) | SimpleWebAuthn |
| Secret vault | Node `crypto` AES-256-GCM, master key from a Docker secret or the OS keyring, key versions for rotation |
| Backup encryption | `age` CLI in the Core image (public-key encryption: the Core can write backups it can't read) |
| Private network | Tailscale |
| TLS and routing | Caddy |
| Logs | pino with redaction |
| Traces | OpenTelemetry (optional export, e.g. Langfuse) |
| Liveness alerting | External dead-man's switch (Healthchecks.io or a self-hosted equivalent) |
| CI and updates | GitHub Actions, Renovate |
| Deployment | Docker Compose |

## 6. Device agents (Phase 4)

| Agent | Stack |
|---|---|
| Desktop (Windows, macOS) | **Tauri 2** (2.12, [Tauri blog](https://tauri.app/blog/tauri-2.12/)) + Rust. Crates: `enigo` (mouse, keyboard), `xcap` (screen and window capture), `uiautomation` (Windows UI Automation), `objc2` bindings for the macOS AX API, `cpal` (microphone), `tokio-tungstenite` (WebSocket), `keyring` (OS credential store). Tauri plugins for tray, global shortcuts and autostart |
| Android | **Kotlin** + Jetpack Compose, `AccessibilityService`, `NotificationListenerService`, foreground service, OkHttp WebSocket, `kotlinx.serialization` |
| Shared contract | JSON Schema exported from `@feroxes/protocol`; Rust and Kotlin types generated from it |

## 7. Voice (Phase 2)

| Area | Choice |
|---|---|
| TTS | ElevenLabs: `eleven_flash_v2_5` for replies (about 100 ms median model latency, WebSocket streaming), `eleven_v4_turbo` for expressive briefings ([ElevenLabs model guide](https://elevenlabs.io/docs/pt/eleven-api/choosing-the-right-model)) |
| STT | ElevenLabs Scribe v2 Realtime, about 150 ms ([ElevenLabs](https://elevenlabs.io/realtime-speech-to-text-api)); adapter interface for alternatives |
| Wake word (Phase 5) | openWakeWord or Picovoice Porcupine, on the device agents |

## 8. Integrations (Phase 3)

`googleapis` (Gmail, Calendar), Microsoft Graph SDK + MSAL (Outlook, calendar), ImapFlow + Nodemailer (any IMAP/SMTP mailbox), Octokit (GitHub), discord.js (bot account), Playwright (browser automation), MCP TypeScript SDK (client).

## 9. Alternatives considered

| Option | Verdict |
|---|---|
| Python core (FastAPI + LangGraph) | Rejected. Richer ML ecosystem, but the UI is TypeScript, Playwright and most integration SDKs are first-class in TypeScript, and local ML runs behind Ollama over HTTP anyway |
| Electron + Node automation modules for the desktop agent | Rejected. Heavier, and the Node desktop-automation native modules are poorly maintained; Rust calls the UIA and AX APIs directly |
| LiteLLM proxy as the router | Rejected as the router, usable as an upstream provider. Its budgets are per key or team, not per task type and priority class, and it can't pause Feroxes's own background jobs |
| OpenRouter only | Rejected as the router, supported as a provider. It adds a middleman to every call and data path |
| Redis + BullMQ | Rejected for now. Another stateful service to back up and monitor; pg-boss handles thousands of jobs a day easily |
| Dedicated vector database (Qdrant, LanceDB) | Rejected for now. They win at tens of millions of vectors; a personal memory holds roughly 10⁴ to 10⁶, where pgvector HNSW is fast and keeps joins, filters and transactions in one place |
| SQLite + sqlite-vec | Rejected. Simplest single-file deployment, but weaker for concurrent background workers and no equivalent of pg-boss |
| Temporal or DBOS durable workflows | Deferred. Strong guarantees, heavier programming model. Persisting every agent step already makes runs resumable |
| Agent frameworks (Mastra, LangGraph.js, AI SDK Agent) | Rejected. Memory, routing, budgets and the policy gate are the product here, and a framework would sit in the middle of all four |
| Hono instead of Fastify | Close call. Hono is lighter and web-standard; Fastify wins on plugin maturity on Node and built-in pino. Switching later touches only `apps/core/src/http` |

## 10. Version policy
- Exact versions pinned; Renovate opens weekly update PRs; major upgrades are done deliberately.
- Security fixes (for example pgvector CVEs) are applied as soon as they're published.
- Provider SDK upgrades must pass the adapter contract tests (recorded fixtures plus a live smoke test) before merging.
