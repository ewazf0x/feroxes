# Feroxes: Project Structure

## 1. Repository layout

```
feroxes/
├── apps/
│   ├── core/                         # Feroxes Core daemon: the composition root
│   │   ├── src/
│   │   │   ├── main.ts               # boot: config → db → migrations → services → http → workers
│   │   │   ├── container.ts          # wiring of all services (manual DI, no framework)
│   │   │   ├── roles.ts              # ROLE=all|api|worker, so the process can split later
│   │   │   ├── config/               # env schema (Zod), defaults, first-run bootstrap
│   │   │   ├── http/
│   │   │   │   ├── server.ts         # Fastify instance, error mapping, graceful shutdown
│   │   │   │   ├── plugins/          # auth, csrf, host-allowlist, rate-limit, request-context
│   │   │   │   ├── routes/           # auth, sessions, runs, approvals, events (SSE), memory,
│   │   │   │   │                     # providers, routing, usage, budgets, policy, audit, system
│   │   │   │   └── sse.ts            # event stream with Last-Event-ID catch-up
│   │   │   ├── workers/              # pg-boss handlers: memory.*, usage.rollup, budget.sweep,
│   │   │   │                         # backup.*, events.trim, audit.verify, heartbeat
│   │   │   ├── scheduler/            # cron registration, admission checks before jobs start
│   │   │   ├── devices/              # device WebSocket gateway (Phase 4)
│   │   │   └── cli/                  # feroxes CLI: migrate, owner:create, stop, resume,
│   │   │                             # backup, backup:verify, audit:verify, export
│   │   └── test/
│   │
│   ├── web/                          # Next.js 16 PWA
│   │   ├── app/
│   │   │   ├── (auth)/login/  (auth)/setup/
│   │   │   ├── (app)/chat/[sessionId]/
│   │   │   ├── (app)/dashboard/
│   │   │   ├── (app)/memory/          # browser, entities, core block
│   │   │   ├── (app)/usage/           # spend, budgets, provider health
│   │   │   ├── (app)/activity/        # runs, run timeline, audit log
│   │   │   ├── (app)/approvals/
│   │   │   ├── (app)/settings/        # providers, routing, budgets, permissions, memory,
│   │   │   │                          # voice, integrations, devices, backups, security
│   │   │   ├── manifest.ts
│   │   │   └── sw.ts                  # Serwist service worker
│   │   ├── components/
│   │   │   ├── ui/                    # shadcn/ui components (owned source)
│   │   │   ├── chat/  memory/  usage/  system/  approvals/
│   │   ├── lib/                       # api client, SSE client, query keys, formatters
│   │   └── public/icons/
│   │
│   ├── desktop-agent/                # Phase 4: Tauri 2 + Rust
│   │   ├── src-tauri/src/
│   │   │   ├── main.rs
│   │   │   ├── protocol/              # types generated from packages/protocol JSON Schema
│   │   │   ├── link/                  # WebSocket client, pairing, reconnect, heartbeat
│   │   │   ├── capture/               # screenshots
│   │   │   ├── a11y/                  # Windows UIA and macOS AX tree snapshots and actions
│   │   │   ├── input/                 # mouse and keyboard, owner-activity detection
│   │   │   ├── apps/  fs/  shell/  clipboard/  audio/
│   │   │   └── safety/                # local policy, kill hotkey, overlay
│   │   └── ui/                        # tray menu and control overlay
│   │
│   └── android-agent/                # Phase 4: Kotlin
│       └── app/src/main/java/dev/feroxes/agent/
│           ├── link/                  # WebSocket client, pairing, foreground service
│           ├── accessibility/         # AccessibilityService: tree, actions, screenshots
│           ├── notifications/         # NotificationListenerService, inline replies
│           ├── protocol/              # generated types
│           ├── safety/                # local stop, allowlists
│           └── ui/                    # Compose screens: pairing, status, permissions
│
├── packages/
│   ├── shared/                       # ids, Result type, error base classes, clock,
│   │                                 # logger and event-bus interfaces. Nothing else.
│   ├── protocol/                     # Zod schemas: REST DTOs, SSE events, device protocol;
│   │                                 # JSON Schema export for Rust and Kotlin
│   ├── db/                           # Drizzle schema (all tables), migrations, client,
│   │                                 # migration runner, test helpers
│   ├── metering/                     # usage ledger, pricing, estimation, budgets,
│   │                                 # reservations, power modes, admission
│   ├── llm/                          # Intelligence layer: model catalog, provider adapters,
│   │                                 # router, health and circuit breakers, embeddings
│   ├── policy/                       # risk categories, permission matrix, autonomy presets,
│   │                                 # approvals, taint, system state (kill switch), audit chain
│   ├── tools/                        # defineTool, registry, Tool Runtime (the policy gate),
│   │                                 # built-in tools, MCP client adapter (Phase 2)
│   ├── memory/                       # memory store, extraction, reconciliation, retrieval,
│   │                                 # consolidation, core block, export
│   ├── agent/                        # runs, loop, context builder, prompts, complexity classifier
│   ├── connectors/                   # Phase 3: connector SDK, OAuth manager;
│   │   └── src/{gmail,outlook,imap,calendar,github,discord,whatsapp,browser}/
│   ├── voice/                        # Phase 2: STT/TTS interfaces, ElevenLabs adapters
│   └── tsconfig/                     # shared tsconfig presets
│
├── config/
│   ├── models.catalog.yaml           # seed model catalog with prices and effective dates
│   ├── routing.default.yaml          # default tiers and routes
│   └── policy.default.yaml           # autonomy presets and the default permission matrix
│
├── infra/
│   ├── compose.yaml                  # postgres (pgvector), core, web, caddy
│   ├── compose.dev.yaml              # postgres only, for local development
│   ├── docker/                       # Dockerfiles (core image includes pg_dump and age)
│   └── caddy/Caddyfile
│
├── evals/                            # memory retrieval and routing evaluation sets + runners
├── scripts/                          # bootstrap, db reset, seed, codegen (protocol → Rust/Kotlin)
├── docs/                             # these documents; ADRs added as decisions change
├── .github/workflows/ci.yml          # lint, typecheck, unit, integration, build
├── package.json  pnpm-workspace.yaml  turbo.json
├── tsconfig.base.json  .oxlintrc.json  .oxfmtrc.json
└── .env.example
```

## 2. Package boundaries and dependency rules

Each package has one job and a public API in `src/index.ts`. Its `package.json` `exports` field lists only that entry, so other packages can't reach into internals.

```
                          shared
                ┌───────────┼─────────────┐
             protocol       db            │
                │     ┌─────┼──────┐      │
                │  metering policy │      │
                │     │     │      │      │
                │    llm    │      │      │
                │     │     │      │      │
                │   memory  tools ─┘      │
                │     │     │             │
                │     └─ agent ──┐        │
                │          connectors   voice
                │                │        │
   apps/web ────┘          apps/core (composition root, depends on everything)
```

| Package | May depend on | Must not depend on |
|---|---|---|
| `shared` | nothing | anything |
| `protocol` | `shared` | `db`, domain packages |
| `db` | `shared` | domain packages |
| `metering` | `shared`, `db` | `llm`, `agent` |
| `policy` | `shared`, `db` | `tools`, `agent` |
| `llm` | `shared`, `db`, `metering` | `memory`, `agent`, `tools` |
| `memory` | `shared`, `db`, `llm` | `agent`, `tools` |
| `tools` | `shared`, `protocol`, `policy` | `agent` |
| `agent` | `shared`, `db`, `llm`, `memory`, `tools`, `policy`, `metering` | `apps/*` |
| `connectors` | `shared`, `db`, `tools` | `agent` |
| `voice` | `shared`, `metering` | `agent` |
| `apps/web` | `protocol` only (talks to the Core over HTTP) | every server package |
| `apps/core` | everything | |

Why these edges:
- `metering` is separate from `llm` because budgets cover every paid API (voice, search, embeddings), and the scheduler needs admission checks without importing the router.
- The Policy Gate lives in `tools` (which depends on `policy`), so every caller, whether the agent, an automation rule, or a UI-initiated action, passes through the same gate.
- `memory` depends on `llm` for embeddings and extraction calls. `llm` never depends on `memory`; the agent's Context Builder combines them.

These rules are enforced in CI with dependency-cruiser, so a wrong import fails the build.

## 3. Inside a domain package

```
packages/memory/
├── src/
│   ├── index.ts          # public API: MemoryService, types, job definitions
│   ├── domain/           # pure logic: scoring, decay, reconciliation rules, types
│   ├── services/         # MemoryService, RetrievalService, ConsolidationService
│   ├── prompts/          # versioned prompt templates (extraction, reconcile, digest)
│   ├── store/            # storage interface + Postgres implementation
│   └── jobs/             # job payload schemas and handlers
└── test/                 # integration tests (Testcontainers)
```

- Pure logic in `domain/` has unit tests with no database.
- `store/` defines an interface and a Postgres implementation. Services depend on the interface, so unit tests use in-memory fakes and integration tests use real Postgres.
- Prompt templates are versioned files. Every model call records the template version, so a quality regression can be traced to a prompt change.

## 4. Conventions

| Topic | Convention |
|---|---|
| Modules | ESM only, `"type": "module"`, `moduleResolution: nodenext` |
| Naming | kebab-case files, PascalCase types, camelCase functions; npm scope `@feroxes/*` |
| Ids | UUIDv7 (time-ordered), generated in Postgres or the app |
| Errors | Typed error classes with a stable `code`; `Result<T, E>` for expected failures in domain code; exceptions for bugs |
| Time | Always UTC in storage; the owner's timezone applies to budget periods, schedules and display |
| Money | `numeric(14,8)` USD in the database; decimal-safe arithmetic in code (integer micro-dollars) |
| Config | YAML files in `config/` seed the database on first boot. After that the database is the source of truth, edited through Settings, with export and import back to YAML |
| Secrets | Never in env files except the master key and the database URL. Provider keys are entered in Settings and stored in the vault |
| Logging | pino, one child logger per run and job, redaction paths for keys, tokens and cookies |
| Tests | `*.test.ts` next to the code for unit tests; `test/` for integration tests |
| Commits | Conventional Commits (`feat(memory): ...`) |

## 5. Environment variables (`.env.example`)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `FEROXES_MASTER_KEY` | 32-byte base64 key for the vault (Docker secret in production) |
| `FEROXES_PUBLIC_ORIGIN` | Origin the PWA is served from, e.g. `https://feroxes.your-tailnet.ts.net` |
| `FEROXES_ALLOWED_HOSTS` | Host allowlist for DNS-rebinding protection |
| `FEROXES_ROLE` | `all` (default), `api`, or `worker` |
| `FEROXES_TIMEZONE` | Initial owner timezone (editable later) |
| `BACKUP_AGE_RECIPIENT` | Owner's age public key for encrypted backups |
| `BACKUP_DIR` | Local backup directory (mounted volume) |
| `HEARTBEAT_URL` | Optional dead-man's-switch ping URL |
