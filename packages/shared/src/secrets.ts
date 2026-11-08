/**
 * Value-level secret scrubbing. Key-based redaction (logger.ts) can't see a credential that sits
 * inside a string: an error message, a URL with ?access_token=, tool output, an audit summary.
 * These patterns are anchored on the documented token prefixes of each provider, so ordinary
 * ids, hashes and UUIDs are left alone.
 */
const PLAIN: RegExp[] = [
  /\bsk-(?:proj-|ant-(?:api\d+-|admin\d+-)?|or-v1-)?[A-Za-z0-9_-]{20,}/g, // OpenAI, Anthropic, OpenRouter
  /\bsk_[A-Za-z0-9]{32,}/g, // ElevenLabs and similar
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API keys
  /\bya29\.[A-Za-z0-9_.-]{20,}/g, // Google OAuth access tokens
  /\b1\/\/0[A-Za-z0-9_-]{30,}/g, // Google OAuth refresh tokens
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g, // GitHub fine-grained tokens
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab personal access tokens
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, // Slack bot/user tokens
  /\bxapp-\d-[A-Za-z0-9-]{10,}/g, // Slack app-level tokens
  /\b(?:secret|ntn)_[A-Za-z0-9]{30,}/g, // Notion integration tokens
  /\bEAA[A-Za-z0-9]{30,}/g, // Meta access tokens (WhatsApp, Instagram via Facebook Login)
  /\bIG(?:AA|QV)[A-Za-z0-9_-]{30,}/g, // Instagram API with Instagram Login tokens
  /\b\d{6,12}:AA[A-Za-z0-9_-]{30,}/g, // Telegram bot tokens
  /\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, // Discord bot tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
const KEEP_PREFIX: RegExp[] = [
  /(\b(?:Bearer|Bot|Basic|token)\s+)[A-Za-z0-9._~+/=-]{16,}/gi, // Authorization header values
  /([?&#](?:access_token|refresh_token|id_token|token|key|api_key|apikey|client_secret|code|code_verifier|password)=)[^&\s#"'<>]+/gi,
  /(\/bot)\d{6,12}:[A-Za-z0-9_-]{30,}/g, // Telegram API URL path
];

/**
 * Masks credentials in `text`. `known` are exact secret values for the current operation (for
 * example the token a connector just used); they are removed even if no pattern matches them.
 */
export function scrubSecrets(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const k of known) if (k && k.length >= 8) out = out.split(k).join('[redacted]');
  for (const p of KEEP_PREFIX) out = out.replace(p, '$1[redacted]');
  for (const p of PLAIN) out = out.replace(p, '[redacted]');
  return out;
}
