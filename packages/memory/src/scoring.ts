import { DAY } from '@feroxes/shared';
import type { Memory, MemoryKind } from './types.ts';

/** Recency half-lives by kind (Phase 1 plan §7.9). `Infinity` means no decay. */
export const HALF_LIFE_MS: Record<MemoryKind, number> = {
  event: 30 * DAY,
  conversation: 60 * DAY,
  digest_day: 180 * DAY,
  digest_week: 180 * DAY,
  digest_month: 365 * DAY,
  fact: 365 * DAY,
  preference: 365 * DAY,
  relationship: 365 * DAY,
  goal: 180 * DAY,
  commitment: 90 * DAY,
  rule: Number.POSITIVE_INFINITY,
  procedure: Number.POSITIVE_INFINITY,
  style: Number.POSITIVE_INFINITY,
};

export const RRF_K = 60;

export function rrf(ranks: (number | undefined)[]): number {
  let s = 0;
  for (const r of ranks) if (r !== undefined) s += 1 / (RRF_K + r);
  return s;
}

export function recencyWeight(m: Memory, now: number): number {
  const half = HALF_LIFE_MS[m.kind];
  if (!Number.isFinite(half) || m.pinned) return 1;
  const ref = m.layer === 'episodic' ? (m.occurredAt ?? m.createdAt) : m.updatedAt;
  const age = Math.max(0, now - ref);
  return 0.5 + 0.5 * 2 ** (-age / half);
}

export const importanceWeight = (m: Memory) => 0.5 + clamp01(m.importance);
export const confidenceWeight = (m: Memory) => 0.5 + 0.5 * clamp01(m.confidence);

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * Maximal Marginal Relevance: picks items that are relevant but not near-duplicates of what
 * was already picked. λ = 1 is pure relevance.
 */
export function mmr<T>(items: { item: T; score: number; vector?: number[] }[], k: number, lambda = 0.7): T[] {
  const pool = [...items];
  const picked: typeof items = [];
  const maxScore = Math.max(1e-9, ...pool.map((p) => p.score));
  while (picked.length < k && pool.length > 0) {
    let best = 0;
    let bestValue = -Infinity;
    pool.forEach((cand, i) => {
      const sim = cand.vector ? Math.max(0, ...picked.map((p) => (p.vector ? cosine(cand.vector!, p.vector) : 0))) : 0;
      const value = lambda * (cand.score / maxScore) - (1 - lambda) * sim;
      if (value > bestValue) {
        bestValue = value;
        best = i;
      }
    });
    picked.push(pool.splice(best, 1)[0]!);
  }
  return picked.map((p) => p.item);
}

/** Rough token count for packing context sections. */
export const approxTokens = (text: string) => Math.ceil(text.length / 4);

// ---------- keyword search (used by the in-memory store; Postgres uses ts_rank_cd) ----------

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'of', 'to', 'and', 'or', 'in', 'on', 'at', 'for', 'with', 'by', 'it', 'this', 'that', 'my', 'me', 'i', 'you', 'your', 'what', 'who', 'when', 'where', 'how', 'do', 'does', 'did', 'about', 'owner', "owner's", 'has', 'have']);

export function terms(text: string): string[] {
  return (text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? []).map(stem).filter((t) => t.length > 1 && !STOP.has(t));
}

/** Tiny suffix stemmer: enough for "sisters" ↔ "sister", "meetings" ↔ "meeting". */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 3 && w.endsWith('es') && !w.endsWith('ses')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
