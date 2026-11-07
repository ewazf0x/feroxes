/**
 * Credentials never become memories (architecture §7.2). This filter runs before and after
 * extraction and on explicit "remember" requests; the vault is the only place for secrets.
 */
const PATTERNS: RegExp[] = [
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/, // OpenAI / Anthropic style keys
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}\b/, // Google API key
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /\b(?:password|passwd|passcode|pin|secret|api[ _-]?key|token)\s*(?:is|=|:)\s*\S{4,}/i,
  /\b(?:\d[ -]?){13,19}\b/, // card-number-like digit runs
];

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function containsSecret(text: string): boolean {
  if (PATTERNS.some((p) => p.test(text))) return true;
  // Long random-looking tokens (≥ 32 chars, high entropy, mixed character classes).
  for (const token of text.match(/[A-Za-z0-9+/=_-]{32,}/g) ?? []) {
    const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(token)).length;
    if (classes >= 2 && shannonEntropy(token) > 4) return true;
  }
  return false;
}
