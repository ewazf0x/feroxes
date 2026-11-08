# 09 — What is implemented, what is tested, what still needs you

Status on 8 November 2026, branch `desktop-pc-app` (PR #1). The rule used here: a feature counts
as **verified** only if a test or a live check exercised it for real. Code that exists but hasn't
run against the real service or hardware is labelled as such.

**Environment this was built in.** A Linux sandbox with *no* outbound internet (only GitHub through
a gateway), no Windows or Android hardware, no Android SDK, no Rust crate registry, and no API
keys or test accounts. Everything marked "needs you" below is blocked by one of those, not by
missing code.

## Legend

| Mark | Meaning |
|---|---|
| ✅ verified | Ran for real here: real processes, sockets, files, crypto, HTTP stack |
| 🧪 contract-tested | Code calls the official API; tests check the exact requests and parse the official response shapes, but no real account was used |
| 🔑 needs credentials | Will be verified by `feroxes live …` once you add keys or connect an account |
| 🖥 needs hardware | Will be verified by `feroxes-agent selftest` (or by hand) on the real device |
| ⏳ not built | Not implemented yet |

## Security

| Item | Status |
|---|---|
| Secret scan of the full git history (31 commits, all branches) | ✅ No real credentials. Only fake keys in two tests (`sk-proj-abcd…` in a secret-detection test, `apiKey: 'should…'` in a redaction test) |
| Repository visibility | ❌ **Still public.** The GitHub API refuses the change from this sandbox (HTTP 403, even though the token reports admin rights). Change it yourself: repo → Settings → General → Danger zone → Change visibility |
| Vault: AES-256-GCM, key outside the database (`FEROXES_MASTER_KEY` or `<data>/master.key`, 0600) | ✅ |
| All credentials sealed at rest (device signing key, connector tokens, OAuth app secrets) | ✅ (tested: no plaintext in the database file) |
| Secrets scrubbed from logs, audit summaries, tool output and errors | ✅ (documented token formats plus the exact values used for each call) |
| Master key in the OS keychain (DPAPI / Keychain) instead of a file | ⏳ |

## Phase 1 — functionality

| Item | Status | How it was verified / what's left |
|---|---|---|
| Device transport: WebSocket at `ws://127.0.0.1:<port>/devices` | ✅ | RFC 6455 server with no dependencies, tested with a real client and raw frames: fragmentation, ping/pong, dropping a silent peer, refusing unmasked/binary/oversized frames, refusing browsers (Origin header) |
| Phone reachability over Tailscale (device-only listener) | ✅ code, 🖥 | `FEROXES_DEVICE_HOSTS=100.x.y.z` serves only the device endpoint. Not tested over a real tailnet |
| **PC device agent** (`apps/pc-agent`) — protocol, security, lifecycle | ✅ | Real Core and agent processes on Linux: pairing, saved token, pinned Core key, refusing forged, replayed, expired and foreign commands and an impersonated Core, cancel kills the running process, local pause, STOP/resume, reconnect, exit with the parent |
| PC agent — files, shell, system status, Kiro CLI | ✅ on Linux, 🖥 on Windows | Real execution with folder limits (symlink escape refused). The same code paths run on Windows |
| PC agent — **Windows** screenshot, mouse, keyboard, clipboard, apps, windows, UI Automation tree and actions, wake timers, DPAPI token | 🧪 🖥 | PowerShell scripts are constants, and parameters travel only as JSON in the environment (tested). **Never run on Windows.** On your PC, run: `node apps/pc-agent/src/cli.ts selftest` (add `--with-input` to include keyboard input) |
| PC agent — Linux/macOS desktop actions (xdotool, wmctrl, grim/scrot, screencapture…) | 🧪 🖥 | Only advertised when the tool is installed |
| The Core starts and pairs this PC's agent automatically | ✅ | `FEROXES_LOCAL_AGENT=1` (set by the desktop app): pairs once, reuses the pairing after a restart, and the agent exits with the Core |
| **Android app** (Kotlin) and **Android device agent** | ⏳ | Can't be built here: there is no Android SDK, and Maven/Google repositories are unreachable. The protocol (JSON Schema), the Core side and the phone tools are ready |
| ElevenLabs STT/TTS in the Core | 🧪 🔑 | Adapters with mocked tests. Live check: `feroxes live voice` (speaks a sentence, then transcribes it back) |
| Voice in the apps (microphone, speaker) | ⏳ | |
| Provider requests (Kiro, Anthropic, OpenAI, Gemini, OpenRouter, Ollama) | 🧪 🔑 | `feroxes live providers` sends one real request per configured model. **No real request has been made yet**: there is no network here |
| Provider fallback, token metering, spending limits | ✅ logic, 🔑 live | Unit tests cover failover, ledger and budgets. Live checks: a deliberately wrong key must fail over to a working model, the ledger must record real tokens, and a $0.000000001 budget must refuse before any request leaves. That last check already passes here |
| Model ids and prices in the catalog | 🔑 | Taken from third-party summaries (Oct 2026). `feroxes live providers` reveals wrong ids; check prices on the providers' pages |

## Phase 2 — integrations framework and connectors

Framework (`packages/connectors`), ✅ tested:
- OAuth 2.0 with PKCE (S256), a single-use 10-minute state, and a loopback redirect.
- Token sign-in for bots and personal tokens.
- Credentials kept in the vault only.
- Refresh before expiry and once on a 401, keeping rotated refresh tokens.
- An expired or revoked grant marks the account "Reconnect needed".
- Per-account permission switches, mapped to scopes.
- Health checks every 6 hours, plus weekly renewal of long-lived tokens.
- Revocation on disconnect.
- Audit entries for connect, disconnect, permission and health changes, and for every action.
- Every action runs as a tool through the policy gate.
- Content written by others comes back untrusted and taints the run. A test proves that a Telegram message can't get an email sent, even on autopilot.

Connectors: all use official APIs and supported authentication. All are 🧪, and each needs 🔑 a real account: connect it in Integrations, then run `feroxes live connectors`.

| Service | Auth | Implemented capabilities | Key platform limits (full list in the app) |
|---|---|---|---|
| Instagram | Long-lived Instagram token (Instagram API with Instagram Login) | Profile, media, account and post insights, comments (read, reply, hide, delete), tags, publishing photos, reels, stories and carousels, publishing quota, DMs (read and reply) | Professional accounts only. The personal-account API (Basic Display) ended on 4 Dec 2024. Media must be at a public HTTPS URL. DMs only within 24 h, and need App Review |
| Discord | Bot token; bot added through the OAuth2 invite link | Servers, channels, reading messages, posting, DMs from the bot | Bots only (self-bots are against Discord's terms). Server message text needs the Message Content intent. No Gateway (real-time) yet |
| Telegram | Bot API token | Reading messages sent to the bot (offset persisted), chats, sending | The bot sees only its own chats, not your personal ones |
| WhatsApp Business | Cloud API system user token | Text inside the 24 h window, template messages, template list | Business numbers only, not your personal WhatsApp. Receiving needs a public webhook, so it isn't wired |
| Slack | Bot token, plus an optional user token | Channels, history, search (user token), posting | The bot reads only channels it was invited to |
| Reddit | OAuth2 (installed app) | Subreddits, inbox, posting text, replies | Data API terms and rate limits |
| Google | OAuth2 + PKCE, your own Desktop client | Gmail (search, read, send), Calendar (list, create, invite), Drive (search, read, create, trash), Contacts (search) | In "Testing" mode, refresh tokens expire after 7 days. Restricted scopes |
| Microsoft Outlook | OAuth2 + PKCE (public client) | Mail (search, read, send), calendar (view, create) | No revocation endpoint; remove the app in your Microsoft account |
| Notion | Internal integration token | Search, read pages, create pages, append | Only pages shared with the integration |
| GitHub | Fine-grained personal access token | Notifications, repos, issue search, issue with comments, files, create and close issues, comment | Limited to what the token allows |
| GitLab | Personal access token (+ self-managed URL) | Projects, your issues and MRs, create issues, comment | |
| Visual Studio Code | Local `code` CLI | Open files and folders, diff, list and install extensions | No editor state without a VS Code extension (not built) |

Not built: incoming webhooks (WhatsApp, Instagram), the Discord Gateway, and Slack Socket Mode. All of these need either a public URL or a persistent connection, which is the next step.

## Phase 3 — Integrations dashboard

| Item | Status |
|---|---|
| Desktop Integrations screen: connect/disconnect, connected services, per-account permissions, health and status, reconnect for expired tokens, activity and audit history, platform limitations | ✅ built. Rendered in demo mode in dark and light, checked for layout problems, screenshots taken |
| Android Integrations screen | ⏳ (with the Android app) |

## Phase 4 — desktop completion

| Item | Status |
|---|---|
| Visual check of every screen | ✅ automated sweep: 9 screens × 2 themes × 2 widths = 36 checks, no layout problems or console errors. The fixes it found are in commit "Integrations screen; visual sweep fixes". Screenshots: Today (dark), Integrations (dark), Integrations drawer (light) |
| Light and dark themes | ✅ both render cleanly. A missing color token (`--c-accent-2`) was fixed |
| Animations and responsiveness | Partly: drawer, toggle and tile transitions; reduced-motion respected; 900 px layout checked. A full motion pass is still to do |
| Windows installer | 🧪 the GitHub Actions workflow exists. **Blocked:** Actions is locked on your GitHub account (billing), and this sandbox can't compile Rust |
| Automatic updates with integrity verification | ⏳ planned: the Tauri updater plugin with signed (minisign) update manifests |
| Packaged app tested on Windows | ⏳ 🖥 |

## Phase 5 — how to finish verification on your side

1. **Make the repo private** (see above).
2. **Providers:** put keys in `<config>/feroxes/.env` (Windows: `%APPDATA%\feroxes\.env`), then run `node apps/core/src/cli.ts live providers`.
3. **Voice:** add `ELEVENLABS_API_KEY`, then run `… live voice`.
4. **Accounts:** connect each service in Integrations (each drawer has setup steps), then run `… live connectors`.
5. **Windows PC:** run `node apps/pc-agent/src/cli.ts selftest`, and paste the output to me.
6. **Installers:** fix the GitHub billing lock, then re-run the Desktop workflow on PR #1.

Send me the outputs and I'll fix whatever fails.

## Update — AI providers in Settings (fixes "No model is eligible for route chat.turn")

**Cause.** Providers could only be set through `.env`, and production used a built-in list of model ids taken from third-party summaries, which might not exist. With no `.env`, the router had no models at all. The chat error pointed to a "Settings → Providers" screen that didn't exist.

**Fix.**
- **Settings → Providers** covers OpenAI, Anthropic Claude, Google Gemini, OpenRouter, Ollama and Kiro (CLI). For each one you can:
  - save, replace or remove the key (sealed in the Vault, shown masked afterwards);
  - turn the provider on or off;
  - find models with the provider's documented model-list API, or type a model id;
  - assign each model to fast, balanced, frontier or local, and choose the chat model;
  - enter prices (OpenRouter supplies them);
  - run a real connection test.
- **Changes apply immediately** to the live router, with no restart. They persist across restarts, and keys from `.env` are imported once.
- **No invented model ids or prices.** Unknown prices use a deliberately high estimate ($15 / $75 per 1M tokens), so spending limits trigger early rather than late.
- **Router:** an empty or failing tier now falls back to the nearest configured tier. Background work never moves to a more expensive tier. With nothing configured at all, the error says so plainly.
- **Kiro:**
  - Uses the official CLI in headless mode (`kiro-cli chat --no-interactive`, prompt on stdin), with your existing `kiro-cli login` or `KIRO_API_KEY`. Kiro documents API keys for headless use on Pro, Pro+, Pro Max and Power plans.
  - Detects whether the CLI is installed (`--version`) and signed in (`whoami`).
  - Never passes `--trust-tools` or `--trust-all-tools`, so Kiro only reasons and Feroxes's policy gate runs every action.
  - Stays **off until you accept a terms notice.** Kiro's billing terms restrict using a subscription through third-party harnesses, and that may apply here.
  - I couldn't load the exact current text of that billing FAQ in this session (the page renders client-side). The notice is based on the earlier check, recorded in docs/06.

**Verified here (with local stand-ins, labelled as such in the tests):**
- Ollama end to end over real HTTP to a local server that speaks Ollama's API: model list, test, a chat answer, ledger tokens, and a wrong model id explained.
- Keys sealed (no plaintext in the database file), masked, and kept across a restart.
- Fallback from a provider that rejects its key to the next one.
- The spending limit refuses a test before any model request is sent.
- Kiro run through a stub `kiro-cli` program: detection, sign-in status, headless call with the prompt on stdin, no `--trust` flags, and the signed-out case.

**Not verified (needs you):** real requests to OpenAI, Anthropic, Gemini, OpenRouter, Ollama on your PC and Kiro on your PC. In the app use **Test connection** on each provider, or run `node apps/core/src/cli.ts live providers`.
