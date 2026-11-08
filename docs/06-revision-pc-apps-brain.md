# Revision 2 (2026-11-08): PC-hosted Core, native apps, devices, voice, brain

> This document supersedes the parts of docs 01–05 it mentions. Where they disagree, this one wins.

## 1. Owner decisions

| Decision | Replaces |
|---|---|
| Feroxes runs on the owner's own PC, not a cloud VM | Oracle Cloud hosting (01 §4.1) |
| Native apps for PC (Windows, macOS) and Android, no web app | Next.js PWA (01 §5.13, §14; 02 §4) |
| Device control and voice come right after the foundation | Phase order in 05 |
| A "brain" layer: self-model, goals, awareness, reflection, debate | Phase 5 scope in 05 |
| Kiro is used through Kiro CLI for coding tasks | "Kiro is not usable" (02 §3.2) |

## 2. Running on the owner's PC

- **Core:** the same Node.js Core, started by the desktop app as a background process (a Node single-executable sidecar bundled with the app) and kept running from the tray when the window is closed. It starts at login.
- **Storage:** one SQLite file (built into Node, `node:sqlite`) in the app data folder (`%APPDATA%\Feroxes` on Windows, `~/Library/Application Support/Feroxes` on macOS). It holds memory with full-text search and vectors, conversations, runs, the cost ledger, budgets, approvals, the append-only audit log, devices, goals and the self-model. Built and tested: `packages/store-sqlite`.
  - **Why SQLite instead of PostgreSQL:** a desktop shouldn't need a database server. One process writes, WAL mode lets the apps read, transactions keep budget reservations atomic, and a backup is a consistent file copy (`VACUUM INTO`, nightly at 04:00).
  - **Vectors:** exact search in JavaScript, about 15 ms per 10,000 memories. Add the `sqlite-vec` extension when the store passes about 100,000 memories.
  - **Encryption at rest:** use the OS disk encryption (BitLocker or FileVault). Secrets live in the vault (AES-256-GCM). Encrypted backups (age) and an SQLCipher option come later.
- **Phone:** the Android app connects to the PC over Tailscale, so it works from anywhere. When the PC is off, the phone app shows it as offline.
- **Sleep mode.** A PC that is *asleep* (suspended) runs nothing, so Feroxes can't watch, remind or answer while it sleeps. There are three options, and they can be combined:
  1. Keep the PC awake with the screen off. Feroxes is idle most of the time, so the power draw stays low.
  2. Let Feroxes wake the PC for scheduled work, using Windows wake timers or `pmset schedule wake` on macOS. The desktop app exposes this as `desktop.schedule_wake`.
  3. Accept gaps. The scheduler remembers when each job last ran and catches up once on wake: one missed morning briefing runs once, not once per missed day (tested).

## 3. Native apps

Both apps talk to the Core with the same device protocol (§4). Their types are generated from `packages/protocol/device-protocol.schema.json`.

**Desktop app: Tauri 2 (Rust core + React UI).** Windows and macOS, Linux best effort.

| Part | Responsibility |
|---|---|
| UI (React, Tailwind, shadcn/ui inside the native window) | Chat, voice, approvals, dashboard (spend, devices, goals), memory browser, self-model and goals editor, settings, STOP on every screen |
| `link` (Rust) | WebSocket to the Core, pairing, token in the OS keychain, Core public key pinned, Ed25519 signature check on every command, replay protection |
| `perception` | Screenshots (`xcap`), accessibility tree (Windows UI Automation, macOS AX API) as compact text with element ids |
| `action` | Background actions on elements (Invoke, SetValue, Toggle; AXPress, AXSetValue) first; visible mouse and keyboard (`enigo`) second |
| `safety` | "Feroxes is in control" overlay with a stop button, global kill hotkey, pause on owner input (sends `owner_activity`), local allow and deny lists (never inside banking or password apps), allowed folders for file access |
| `system` | Heartbeats (CPU, RAM, disk, battery, network, lock state, foreground app), wake timers, tray, autostart, notifications |
| `voice` | Push-to-talk hotkey, microphone (`cpal`), playback (`rodio`), stop playback when the owner starts talking (barge-in) |
| `kiro` | Runs Kiro CLI headless for `code.kiro`; the Kiro API key stays in the PC's keychain |
| Core sidecar | Starts and supervises the Core process |

**Android app: Kotlin + Jetpack Compose.**

| Part | Responsibility |
|---|---|
| UI (Compose) | Chat, push-to-talk button, approvals (also from notifications), devices and spend at a glance, STOP |
| `FeroxesAccessibilityService` | Screen as an accessibility tree, node actions (click, set text, scroll), gestures, global actions, screenshots (Android 11+) |
| `FeroxesNotificationListener` | Incoming notifications become events; replies use the app's own inline-reply action (WhatsApp, SMS…) |
| `LinkService` (foreground service) | Persistent connection to the PC Core, command execution, heartbeats, a "Feroxes is active" notification with a STOP action |
| Quick Settings tile | Push-to-talk and STOP |

- **Distribution:** installed with ADB (sideloading), because Play policy restricts Accessibility apps. Developer verification starts with four countries on 2026-09-30, and ADB installs still work (sources in 01 §10).
- **iPhone:** iOS doesn't let one app control others, so deep phone control is Android-only. An iOS companion (chat, voice, approvals) is possible later.

**Builds.** The apps can't be compiled in the planning sandbox: there is no access to crates.io, Maven or the Android SDK, and Windows and macOS builds need those systems. They are built by GitHub Actions on `windows-latest`, `macos-latest` and `ubuntu-latest` (Android) runners. The installers (`.msi`/`.exe`, `.dmg`, `.apk`) are published as release downloads. This needs the GitHub repository.

## 4. Device control (built in the Core: `packages/protocol`, `packages/devices`)

- **Pairing:** a one-time code (8 characters, 10 minutes, single use, 5 wrong codes per minute at most) is shown by `/pair` or by an already-paired app. The device receives a random 32-byte token (stored hashed in the Core) and the Core's Ed25519 public key.
- **Commands:** signed by the Core over the exact payload bytes. The device checks the signature, its own device id, the expiry, and that the id hasn't been seen before. A device pinned to one Core refuses a Core with a different key (tested).
- **26 actions** in protocol v1, each tied to one capability. Tools: `desktop.*` (screenshot, ui_tree, act, click, type, key, scroll, apps, launch, windows, focus, clipboard, files, read/write file, shell, status, schedule_wake), `phone.*` (screenshot, ui_tree, act, tap, swipe, global, apps, launch, notifications, reply, status), `devices.list`, `code.kiro`. Device tools are offered to the model only while a matching device is online.
- **Risk levels** come from one table in `packages/devices/src/tools.ts`:

| Category | Tools |
|---|---|
| read | screenshots, UI tree, app and window lists, file reads, status |
| device_control | clicks, typing, element actions, launching apps |
| destructive | shell commands, overwriting files |
| communicate | phone replies |
| external_write | `code.kiro` |

- **"Allow for this task":** one approval can cover the remaining device-control actions of the same task (15 minutes). It never covers sending, deleting, buying or settings, and STOP revokes it. Screen contents count as untrusted, but a task grant covers device control anyway; that is the owner's explicit choice. Everything else in a tainted run still asks. For example, a WhatsApp message asking for bank details can't make the phone reply, even on autopilot (tested).
- **Owner-activity pause:** while the owner moves the mouse or types, visible input is refused with a clear error and background element actions still work.
- **STOP:** halts every paired device (`halt`), rejects pending commands, refuses new ones, and sends `resume` afterwards.
- **Vision:** screenshots reach the model as images, and only the latest two are kept in context to save tokens. The prompt tells the model to prefer the accessibility tree.

## 5. Voice (built: `packages/voice`)

- **Push-to-talk:** the clip goes to ElevenLabs Scribe (`scribe_v2`, batch) for speech-to-text. The agent answers, and the reply is spoken sentence by sentence with `eleven_flash_v2_5` over HTTP streaming, so speech starts after the first sentence. `previous_text` keeps the intonation smooth between sentences.
- **Spoken STOP:** saying "Feroxes, stop" triggers the kill switch instead of a chat turn.
- **Metering:** voice goes through the same budgets and ledger as tokens (STT per second, TTS per character). If the budget runs out mid-answer, the rest of the answer arrives as text.
- **Seed prices** (third-party summaries; check them against your ElevenLabs plan): Flash or Turbo TTS $0.05 per 1,000 characters ([Puter](https://developer.puter.com/tutorials/elevenlabs-api-pricing/)), Scribe $0.22 per audio hour ([Stork](https://www.stork.ai/blog/elevenlabs-speech-to-text-scribe-2026)).
- **Next:** realtime STT (Scribe v2 Realtime) for hands-free use, a wake word on the devices, audio delivery to the apps.

## 6. The brain layer (built: `packages/brain`)

The requested loop, mapped to components:

| Step | Component |
|---|---|
| Perception | Device tools, sensors (device health, threats, budget, approvals), later calendar, email and weather sensors through the `Sensor` interface |
| Memory retrieval | Hybrid retrieval and the core block (memory engine) |
| Situation assessment | `SituationService`: one `<situation>` block per turn with anomalies, plus the owner-state model |
| Goal check | Goal hierarchy in the cached system context, with conflicts surfaced |
| Internal debate | `think.deliberate`: Strategist, Critic, Safety Officer, Optimizer and Creative on the fast tier, then a synthesis on the balanced tier |
| Plan and simulate | `plan.update` checklist; the debate synthesis must state the predicted outcome and check alignment with the owner's values |
| Act | Tools through the policy gate |
| Reflect | Nightly reflection over the action journal (intent → actions → outcome) |
| Update memory | Memory extraction, self-model lessons and mistakes, skill proposals, goal proposals, improvement proposals |

**Strong model in the middle, cheap models around it:** the router's tiers. Debate voices, briefings and extraction use the fast tier; synthesis, reflection and chat use balanced or frontier. **Local where possible:** the SQLite store is local, and an optional Ollama tier keeps `secret` data on the PC. **Event-driven with daemons:** the event bus plus a persistent scheduler (situation watch every 5 min, goal pursuit every 15 min, reflection 03:45, memory consolidation 03:30, backup 04:00, briefing 07:30, budget and device sweeps every minute).

**Honest note on "consciousness":** the self-model gives Feroxes a stable identity and a memory of its own past (start count, lessons, mistakes, versions) that survive restarts and device changes. That is continuity, not consciousness.

## 7. The 14 requested capabilities: status

Built means implemented and covered by tests; designed means specified here with a clear place in the code; later means a roadmap phase.

| # | Capability | Status |
|---|---|---|
| 1 | Hierarchical memory | **Built.** Short-term: session plus rolling summary. Episodic: episodes and digests. Semantic: facts and entities. Procedural: rules, procedures, skills. Working memory: run steps plus checklist. "Remember forever" pins a memory at top importance |
| 2 | Self-model and identity continuity | **Built.** Versioned, start count, rollback, owner-locked values, personality and boundaries; the agent may only propose changes to those |
| 3 | Background awareness | **Partly built.** Device health, screen lock, foreground app, battery, network, disk, CPU and RAM via heartbeats; scam detection on phone notifications; budget; approvals; fused into one situation block; proactive alerts with deduplication. **Later:** calendar, email, messages, weather and news sensors (they come with the connectors) |
| 4 | Goal hierarchy and planning | **Built.** Horizons from now to long-term, parent goals, priorities, autonomy levels (inform, suggest, act), agent proposals the owner accepts, a pursuit daemon, conflict detection, sub-agents (`agents.delegate`). **Later:** a dedicated multi-day planner |
| 5 | Self-improvement loop | **Built:** journal, daily reflection, lessons and mistakes in the self-model, skill library (proposed, then activated by the owner), improvement proposals, evolution report (`/growth`). **Designed:** code self-modification only as a Kiro-written pull request the owner reviews; nothing is applied automatically |
| 6 | Internal debate | **Built.** Five perspectives plus a synthesis with predicted outcome and alignment check, a few cents per use |
| 7 | Predictive world model | **Partly built:** activity pattern (active and quiet hours), owner state, goal conflicts, predicted outcomes in debates. **Later:** habit and energy models, need prediction |
| 8 | Deep research mode | **Later:** needs a web search provider, long-running research goals and a knowledge base (entities and relations already exist) |
| 9 | Multi-device embodiment | **Core side built:** device graph with capabilities and live state; one task can use the PC and the phone. **Apps:** next milestone |
| 10 | Resource optimization | **Partly built:** monitoring, anomalies and suggestions. Cleanup actions go through the shell and file tools with approval. **Later:** predictive maintenance on the devices (disk health) |
| 11 | Defensive awareness | **Partly built:** scam pattern detection, taint containment, SSRF guard, signed device commands, approval gates. **Later:** email phishing checks, process monitoring on the devices |
| 12 | Emotional and preference modeling | **Partly built:** owner-state signals (frustration, hurry, late night, corrections) change the style guidance each turn; preferences are inspectable, editable memories; personality lives in the self-model |
| 13 | Daily reflection and briefings | **Built:** morning briefing (07:30, also spoken when voice is set up), nightly reflection, weekly evolution report, live situation and self-state blocks |
| 14 | Safety and interpretability | **Built:** permission layers, approvals, hard floor, task grants limited to device control, append-only audit, "why did you do that?" (`why.explain`, `/why`), STOP from CLI, voice and devices, budgets as rate limits, sandboxed files and web, owner-editable goals, memory and self-model, alignment check in debates. **Later:** step-up authentication (biometrics or passkey in the apps) for the hard floor |

## 8. Safety rules for autonomy

1. The agent proposes and the owner decides: goals, values, personality, boundaries, skills, improvements and permission changes.
2. No self-modification of code, prompts, permissions or safety rules at runtime. Improvements become proposals; code changes become pull requests (written with `code.kiro` if the owner wants) that the owner reviews and merges.
3. Autonomous work runs under background limits (6 steps, $0.10 per run, background budget) and the same policy gate as everything else.
4. High-impact decisions go through debate first. Its synthesis must say whether to ask the owner.
5. Every action is in the hash-chained audit log, and every run can be explained from stored data.
6. One STOP halts the Core, all daemons and every paired device, and revokes task grants.

## 9. Kiro

Kiro API keys run Kiro CLI from scripts: "Developers can use API keys for executing automation scripts with Kiro CLI in their local machine or remote environment like CI/CD pipelines" ([Kiro docs](https://kiro.dev/docs/enterprise/governance/api-keys)). They are not a general model API. Kiro's billing FAQ doesn't allow third-party automation harnesses such as OpenClaw that route requests outside Kiro's own interfaces ([Kiro billing FAQ](https://kiro.dev/docs/billing/related-questions)).

So Feroxes uses Kiro the documented way, for software work. `code.kiro` hands a coding task in one of the owner's repositories to Kiro CLI on the PC:
- Kiro CLI runs headless (`kiro-cli chat --no-interactive`, with `--trust-tools` limited to what the task needs, plus `--sandbox`; flags per the [headless docs](https://kiro.dev/docs/cli/headless)).
- The key is in `KIRO_API_KEY` from the PC's keychain. An existing `kiro-cli login` session takes precedence over the key.
- It needs the owner's approval (`external_write`).

Chat, memory and everything else use Anthropic, OpenAI, Gemini and OpenRouter.

## 10. Updated roadmap

| Phase | Content |
|---|---|
| 1 Foundation | Done in code: router, budgets, policy, memory, agent, SQLite storage, CLI |
| 2 Hands and voice (Core side) | Done: device protocol, hub, PC and phone tools, task grants, voice pipeline, brain layer |
| 3 Apps | Desktop app (Tauri), Android app (Kotlin), Core HTTP and WebSocket server, app builds on GitHub Actions, biometric step-up approvals |
| 4 Connected | Email (multi-account, free-trial tracking), calendar, GitHub, Discord bot, browser automation, WhatsApp through the Android notification bridge; these add sensors to the situation model |
| 5 Deeper brain | Deep research mode with web search and a knowledge base, habit and energy models, realtime voice and wake word, predictive maintenance on devices |
| 6 Hardening | Security review, encrypted backups, sqlite-vec, update channel for the apps |
