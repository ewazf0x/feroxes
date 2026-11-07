# Feroxes: Roadmap

Each phase ends with a 24-hour soak test and explicit acceptance criteria, like Phase 1. Later phases add capabilities on top of the Phase 1 foundations; they don't replace them.

## Phase order and why

| Phase | Theme | Why in this position |
|---|---|---|
| 1 | Foundation | Everything else depends on memory, routing, metering, the policy gate and the agent runtime |
| 2 | Daily driver | Makes Feroxes pleasant to use every day (voice, push, polish) and adds the security pieces (passkeys, step-up) that later phases need |
| 3 | Connected and proactive | Official APIs (email, calendar, GitHub) give daily value at low risk, and turn Feroxes into a 24/7 assistant |
| 4 | Second hand | Device control is the most powerful and riskiest capability; by now the policy engine has months of real use |
| 5 | Autonomy and knowledge | Planning, sub-agents and learning work best once there is history and many tools |
| 6 | Hardening and scale-out | Security review, operations, packaging |

## Phase 2: Daily driver
- **UI:** full dashboard; mobile polish; entity graph view; memory review inbox for low-confidence and contradicting memories.
- **Notifications:** web push, including approve and deny from the notification; high-risk categories open the app for step-up authentication.
- **Security:** passkeys (SimpleWebAuthn); step-up authentication for `financial`, `security` and resume-after-STOP; audit chain head anchored outside the database daily.
- **Voice:** ElevenLabs TTS (Flash v2.5 streaming for replies, v4 Turbo for briefings); Scribe v2 Realtime STT; push-to-talk in the PWA; barge-in; "Feroxes, stop" voice command; voice usage in the ledger.
- **Tools:** MCP client (Streamable HTTP and stdio), imported tools default to `ask`.
- **Policy:** conditional permission rules (recipient, path, amount, time of day).
- **Learning:** feedback-driven routing (thumbs-down on a fast-tier answer raises that pattern's tier); style notes learned from the owner's rewrites and corrections.
- **Cost:** provider batch APIs for `deferrable` work; per-route prompt-cache hit dashboards.
- **Ops:** OpenTelemetry export; offsite encrypted backups to S3-compatible storage.

## Phase 3: Connected and proactive
- **Connector SDK** with multi-account support, shared OAuth manager, sync cursors, health checks.
- **Email:** Gmail, Outlook, generic IMAP/SMTP; smart triage; drafting with approval; subscription and free-trial tracker with reminders before conversion; style learning from the diff between Feroxes's draft and what the owner actually sent.
- **Calendar and tasks:** Google and Microsoft calendars, CalDAV; internal task store with optional external sync.
- **GitHub:** notifications, PRs, issues, reviews.
- **Discord:** bot account that DMs the owner and works in the owner's servers.
- **Browser automation:** Playwright on the Core host with persistent profiles.
- **Proactive engine:** monitors, triggers, automation rules, initiative levels (`inform`, `suggest`, `act`), morning and evening briefings (text, push, voice), deadline reminders, quiet hours, digest batching, notification-noise feedback.
- **Memory:** observation episodes from connectors (important emails, meetings), decision-pattern statistics from triage approvals.

## Phase 4: Second hand
- **Device protocol** published as JSON Schema; pairing with one-time codes; per-device credentials and scopes; revocation.
- **Desktop agent** (Windows, macOS): accessibility tree and screenshots, background (API-level) and visible (mouse and keyboard) automation, apps, files, shell, clipboard, control overlay, kill hotkey, owner-activity pause, push-to-talk hotkey, speakers for proactive speech, attach to the owner's own browser.
- **Android agent:** Accessibility actions and screenshots, notification listener, inline replies, foreground service, quick-settings tile for push-to-talk and STOP.
- **WhatsApp bridge** through Android notifications (default), Business Cloud API if available, unofficial backend only as an explicit opt-in.
- **Computer-use loop** with vision-capable models, per-task device grants, step verification.

## Phase 5: Autonomy and knowledge
- **Planner:** plan, execute, re-plan for multi-step and multi-day goals; revisit durable workflow engines if runs commonly span days.
- **Sub-agents** with narrow toolsets (email agent, device operator), each with its own budget.
- **Controlled web learning:** owner-approved topics and sources, per-topic budgets, citations stored with every learned fact, learned knowledge kept separate from knowledge about the owner.
- **Permission suggestions** from approval history; the owner decides, Feroxes never self-grants.
- **Procedural macros** from successful, repeated automations.
- **Wake word** (openWakeWord or Porcupine) on device agents.
- **Feroxes memory as an MCP server**, so other AI tools can read (and, with approval, write) the owner's memory.

## Phase 6: Hardening and scale-out
- Threat-model review and penetration test of the API, device protocol and connectors.
- Master-key rotation tooling; vault re-encryption.
- Split `api` and `worker` processes; Postgres `LISTEN/NOTIFY` event bus; PostgreSQL 19 upgrade.
- Installers and an update channel for the device agents; disaster-recovery drills.

## Requirement traceability

| Requirement | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 |
|---|---|---|---|---|---|
| 1. Memory | All four layers, extraction, reconciliation, hybrid retrieval, consolidation, owner control, history, suppression, encrypted backups | Review inbox, entity graph UI, offsite backups | Observation episodes from connectors | Device action episodes | Procedural macros |
| 2. Continuous learning | Preferences and corrections via extraction, feedback capture | Feedback-driven routing, style notes | Style from edited drafts, decision patterns | | Controlled web learning, permission suggestions |
| 3. Multi-API + token management | Adapters, catalog, router, failover, ledger, budgets, reservations, power modes, dashboard, alerts | Batch APIs, cache dashboards | | | Per-sub-agent budgets |
| 4. Device control | | | | Desktop and Android agents, computer use, background and visible automation | Wake word on devices |
| 5. Integrations | Sandboxed files, web search and fetch | MCP client | Email (multi-account, trials), calendar, tasks, GitHub, Discord, browser | WhatsApp bridge | Memory as MCP server |
| 6. Voice | | TTS, STT, push-to-talk, barge-in, proactive speech in the PWA | Spoken briefings | Desktop hotkey and speakers, Android tile | Wake word |
| 7. Proactive 24/7 | Scheduler, background jobs, admission control | Web push | Monitors, triggers, rules, briefings, reminders, initiative levels | Device-triggered automations | Planner for long goals |
| 8. UI | Chat, dashboard, memory, usage, activity, approvals, settings, PWA install | Polish, mobile, push | Integrations and automations screens | Devices screens | |
| 9. Safety and control | Policy gate, presets, approvals, taint, kill switch, audit chain | Passkeys, step-up auth, conditional rules, chain anchoring | Per-account scopes | Device-side policy, overlay, kill hotkeys | Suggestion-only autonomy growth |
