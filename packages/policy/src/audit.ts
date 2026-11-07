import { type Clock, Mutex, canonicalJson, redact, sha256Hex, systemClock } from '@feroxes/shared';
import type { RiskCategory } from './permissions.ts';

export type AuditDecision = 'allow' | 'notify' | 'ask' | 'deny' | 'approved' | 'denied' | 'system';
export type AuditOutcome = 'success' | 'failure' | 'pending' | 'blocked';

export interface AuditEntryInput {
  actor: 'owner' | 'agent' | 'system' | 'scheduler';
  action: string; // tool name or system action ("system.stop")
  category?: RiskCategory;
  decision: AuditDecision;
  outcome: AuditOutcome;
  summary: string;
  runId?: string;
  toolCallId?: string;
  details?: Record<string, unknown>;
  costNanoUsd?: number;
}

export interface AuditEntry extends AuditEntryInput {
  seq: number;
  ts: number;
  prevHash: string;
  hash: string;
}

export const GENESIS_HASH = '0'.repeat(64);

/** Append-only storage. Postgres enforces this with a trigger that rejects UPDATE and DELETE. */
export interface AuditStore {
  append(entry: AuditEntry): Promise<void>;
  last(): Promise<AuditEntry | undefined>;
  all(): AsyncIterable<AuditEntry>;
  query(filter: { runId?: string; action?: string; limit?: number }): Promise<AuditEntry[]>;
}

export class InMemoryAuditStore implements AuditStore {
  readonly entries: AuditEntry[] = [];
  async append(entry: AuditEntry) {
    this.entries.push(entry);
  }
  async last() {
    return this.entries.at(-1);
  }
  async *all() {
    yield* this.entries;
  }
  async query(f: { runId?: string; action?: string; limit?: number }) {
    const rows = this.entries.filter((e) => (!f.runId || e.runId === f.runId) && (!f.action || e.action === f.action));
    return f.limit ? rows.slice(-f.limit) : rows;
  }
}

export function hashEntry(prevHash: string, entry: Omit<AuditEntry, 'hash'>): string {
  const { prevHash: _p, ...rest } = entry;
  return sha256Hex(prevHash + canonicalJson(rest));
}

/**
 * Tamper-evident action log (Phase 1 plan §7.13): each entry hashes the previous one,
 * so editing or removing any row breaks the chain from that point on.
 */
export class AuditLog {
  private readonly store: AuditStore;
  private readonly clock: Clock;
  private readonly mutex = new Mutex();

  constructor(deps: { store: AuditStore; clock?: Clock }) {
    this.store = deps.store;
    this.clock = deps.clock ?? systemClock;
  }

  append(input: AuditEntryInput): Promise<AuditEntry> {
    // Serialized so the chain stays linear (Postgres: advisory lock around the insert).
    return this.mutex.run(async () => {
      const last = await this.store.last();
      const prevHash = last?.hash ?? GENESIS_HASH;
      const base: Omit<AuditEntry, 'hash'> = {
        ...input,
        ...(input.details ? { details: redact(input.details) as Record<string, unknown> } : {}),
        seq: (last?.seq ?? 0) + 1,
        ts: this.clock.now(),
        prevHash,
      };
      const entry: AuditEntry = { ...base, hash: hashEntry(prevHash, base) };
      await this.store.append(entry);
      return entry;
    });
  }

  query(filter: { runId?: string; action?: string; limit?: number }) {
    return this.store.query(filter);
  }

  async verify(): Promise<{ ok: true; count: number; head: string } | { ok: false; brokenAtSeq: number; reason: string }> {
    let prev = GENESIS_HASH;
    let expectedSeq = 1;
    let count = 0;
    for await (const e of this.store.all()) {
      if (e.seq !== expectedSeq) return { ok: false, brokenAtSeq: e.seq, reason: `expected seq ${expectedSeq}` };
      if (e.prevHash !== prev) return { ok: false, brokenAtSeq: e.seq, reason: 'previous-hash mismatch' };
      const { hash, ...rest } = e;
      if (hashEntry(prev, rest) !== hash) return { ok: false, brokenAtSeq: e.seq, reason: 'content hash mismatch' };
      prev = hash;
      expectedSeq++;
      count++;
    }
    return { ok: true, count, head: prev };
  }
}
