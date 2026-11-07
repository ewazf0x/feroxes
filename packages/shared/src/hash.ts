import { createHash } from 'node:crypto';

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Deterministic JSON: object keys sorted, undefined dropped, no whitespace.
 * Used wherever a hash must not depend on property order (audit chain, content hashes).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : sortValue(v)));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = sortValue(v);
  }
  return out;
}

/** Normalizes text before hashing so trivial whitespace/case changes map to the same hash. */
export function contentHash(text: string): string {
  return sha256Hex(text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase());
}
