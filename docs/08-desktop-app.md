# 08 — The Feroxes desktop app (PC)

The PC app is a **native Tauri 2 shell** around the Feroxes Core. The window is a thin host; all the
thinking, memory, budgets and device control live in the Core (the same code the CLI runs). This
keeps the app small and the brain identical across surfaces (PC now, Android next).

> **Build status.** The Core side of this (the `serve` command, the self-contained packaging, the
> handshake) is implemented and verified end to end on Linux in CI's sandbox. The Rust shell
> (`apps/desktop/src-tauri`) is written to current Tauri 2.12 APIs but has **not been compiled here**
> — this environment has no Rust crate registry access. It is compiled and bundled by the
> **Desktop** GitHub Actions workflow on real macOS/Windows/Linux runners. Treat the first CI run as
> the compile check.

## How it fits together

```
┌─ Feroxes.app (Tauri, Rust) ─────────────────────────────┐
│  WebviewWindow  ──loads──►  ui/www (index.html + JS/CSS) │
│       ▲  window.__FEROXES__ = { url, token }             │
│       │                                                  │
│  setup(): attach-or-spawn                                │
│       │                                                  │
│       ├─ attach ─► a Core already running (24/7)         │
│       └─ spawn  ─► bundled Node + Core (child process)   │
└───────────────────────────│─────────────────────────────┘
                            │  HTTP + SSE on 127.0.0.1 (app token)
                            ▼
                   Feroxes Core  ──►  SQLite (one file)
```

- **The Core is a local service.** `feroxes serve` (see `apps/core/src/cli.ts`) starts the HTTP +
  server-sent-events API on `127.0.0.1`, bound to the loopback interface only. Every request carries
  the app token; `Host`/`Origin` are checked to block DNS-rebinding.
- **Handshake.** `serve` prints one line on stdout — `FEROXES_READY {"url":...,"token":...}` — and
  writes the same to `runtime.json`. The shell reads either to learn where the Core is.
- **Injection.** The shell builds the window with an initialization script that sets
  `window.__FEROXES__ = { url, token }` before the UI loads. The UI (`apps/desktop/ui/src/api.ts`)
  reads it and talks to the Core.

## Attach vs. spawn (and why 24/7 works)

On launch the shell:

1. **Attaches** to a Core that is already running, if one is: it reads
   `<config-dir>/feroxes/runtime.json` and checks that something is listening on that port. This is
   the 24/7 background brain — the window is just a viewer, and closing it leaves the Core running.
2. Otherwise **spawns** the bundled Core as a child process and reads its stdout handshake. That
   child is stopped when the app quits; a background Core is never touched.

Both the app-spawned Core and a background `feroxes serve` default to the **same data directory**
(`<config-dir>/feroxes`), so there is always exactly one brain and one SQLite file — never two
processes writing the same database.

`<config-dir>` is the per-user config directory, identical on both sides (`dirs::config_dir()` in
Rust, `feroxesConfigDir()` in the CLI):

| OS | Path |
|---|---|
| Windows | `%APPDATA%\feroxes` |
| macOS | `~/Library/Application Support/feroxes` |
| Linux | `$XDG_CONFIG_HOME/feroxes` or `~/.config/feroxes` |

## Packaging: a self-contained Core

Node refuses to strip TypeScript types for files under `node_modules`, so for the shipped app the
Core is **compiled to JavaScript** and staged as a normal package tree
(`scripts/build-desktop.mjs`):

```
src-tauri/resources/
  core/
    package.json              # exports point at ./src/index.js
    src/*.js                  # apps/core compiled
    node_modules/@feroxes/*   # every workspace package, compiled to .js
    node_modules/zod/         # the one third-party runtime dep
  runtime/
    node (or node.exe)        # the exact Node 24 used to build (CI adds this)
```

The shell runs `runtime/node core/src/cli.js serve`. If `runtime/node` is absent (a dev build), it
falls back to `node` on `PATH`. **This staged tree is verified to boot and serve the API** (it is how
the sandbox tested packaging without the Rust layer).

## Providing API keys / the Kiro brain

The shell passes its environment to the Core, and additionally reads an optional
`<config-dir>/feroxes/.env` (via Node's `--env-file`). The simplest setup is to drop a `.env` there:

```
# ~/.config/feroxes/.env  (macOS: ~/Library/Application Support/feroxes/.env)
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
FEROXES_KIRO_BRAIN=true
FEROXES_KIRO_USE_LOGIN=true   # use an existing `kiro-cli login` session as the main brain
```

With no keys at all the app still opens on a clean first run (the dashboard, memory, goals and
settings work); chat and reasoning report that no provider is configured until you add one. See
`.env.example` and [07 — Kiro as the brain](07-kiro-brain.md).

## Build it

Prerequisites: Node 24+, pnpm 10+, the Rust toolchain, and the Tauri 2 OS prerequisites
(WebView2 on Windows, `webkit2gtk-4.1` on Linux, Xcode CLT on macOS).

```bash
pnpm install
pnpm run desktop:build     # builds the UI, compiles + stages the Core, generates icons, bundles
```

Installers land in `apps/desktop/src-tauri/target/<triple>/release/bundle/`
(`.dmg`, `.msi`/`-setup.exe`, `.AppImage`/`.deb`). For a fully self-contained installer, bundle a
Node binary first:

```bash
mkdir -p apps/desktop/src-tauri/resources/runtime
cp "$(node -e 'process.stdout.write(process.execPath)')" apps/desktop/src-tauri/resources/runtime/node
pnpm run desktop:build
```

### CI

The **Desktop** workflow (`.github/workflows/desktop.yml`) builds all four targets
(macOS arm64 + x64, Windows x64, Linux x64) on push of a `v*` tag or via *Run workflow*. It stages
the Core, bundles the runner's Node binary, generates icons, runs `tauri build`, and uploads the
installers as artifacts.

## Dev loop

```bash
# Terminal 1 — run the Core (the app will attach to it; survives app restarts)
pnpm run serve

# Terminal 2 — run the shell in dev mode (rebuilds the UI, then `tauri dev`)
pnpm run desktop:dev
```

Or just `pnpm run desktop:dev` and let the shell spawn its own Core.

## Security notes

- The Core listens on `127.0.0.1` only, never on a routable interface.
- Every API request needs the app token (persisted at `<data-dir>/app-token`, mode `0600`).
- The window's content security policy allows connecting only to `127.0.0.1` and loading scripts
  from the app bundle (`apps/desktop/src-tauri/tauri.conf.json`).
- The UI uses no Tauri IPC and no Node integration; it is ordinary web code talking to a local HTTP
  API, so the attack surface is just the Core's authenticated endpoints.
