# Kiro as the main brain (owner decision, 2026-11-08)

The owner asked for this explicitly, twice, and accepts the risk. It overrides the earlier note in docs/02 §3.2 that Kiro wouldn't be used as a provider.

## What changed
Kiro is now Feroxes's **default reasoning engine**. Chat, planning, decisions and reflection go through Kiro first; the API models (Claude, GPT, Gemini, OpenRouter) are the **fallback** used only when Kiro errors, hits its quota, or isn't installed.

## How it works
- **Transport:** the `KiroAdapter` (`packages/llm/src/adapters/kiro.ts`) drives the official Kiro CLI the way its docs describe for local scripts: `kiro-cli chat --no-interactive`, prompt on stdin, answer on stdout ([headless docs](https://kiro.dev/docs/cli/headless)). Auth is `KIRO_API_KEY`, or an existing `kiro-cli login` session.
- **Kiro reasons; Feroxes acts.** Feroxes renders the conversation and the available tools into one prompt and parses Kiro's reply. It **never** passes `--trust-all-tools`, so Kiro CLI's own tools stay off and every real action still goes through Feroxes's policy gate, approvals and audit log. A tool request comes back as one line (`⟦FEROXES_TOOL⟧ {json}`) that Feroxes executes under its own rules. This keeps "it proposes, I decide" intact with Kiro in the middle.
- **Routing:** Kiro sits first in the `frontier` and `balanced` tiers; `chat.turn` is floored to the balanced tier so conversation always reaches Kiro. If Kiro fails, the router falls over to the next candidate automatically (the same failover used for any provider).
- **Fallback is automatic.** Exit codes and stderr are classified: auth → `auth_error`, credit/quota → `quota_exhausted`, rate/throttle → `rate_limited`, anything else non-zero → retryable `server_error`. All of these make the router try the API models next.

## Deliberate limits (with reasons)
- **Fast-tier utility stays on cheap API models by default** (memory extraction, reconciliation, classification, summaries, the debate "perspective" voices, briefings). These are high-frequency background calls, not "major thinking," and a Kiro subprocess per call would be slow and burn subscription credits around the clock. Set `FEROXES_KIRO_SCOPE=all` to route these through Kiro too.
- **Embeddings never use Kiro** (it has no embedding endpoint); they stay on the API embedding model.
- **Vision:** images aren't sent through the CLI, so Kiro models don't declare the `vision` capability and the router routes any image turn to a vision-capable API model.
- **No token streaming:** the CLI prints the first response once, so a reply arrives as a single chunk rather than token by token. Chat still streams at the run level (tool steps, status).
- **Cost:** Kiro is billed as subscription credits, so Kiro calls are $0 in Feroxes's token ledger. The dashboard shows Kiro call counts; credit usage lives in Kiro's own `/usage`.

## Risks the owner accepted
- Kiro's terms don't sanction driving a third-party assistant with the subscription; this could put the Kiro account at risk. The owner was told and chose to proceed.
- Latency and throughput depend on the local CLI and the plan's limits. The automatic fallback to API models keeps Feroxes responsive if Kiro throttles.

## Configuration
See `.env.example` (the `FEROXES_KIRO_*` and `KIRO_*` variables). Turn it off with `FEROXES_KIRO_BRAIN=false` to go back to the API models as the brain.
