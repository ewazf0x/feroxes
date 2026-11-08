import type { AgentStore, Run, RunStatus, Session, SessionMessage, Step } from '@feroxes/agent';
import { type CoreSnapshot, type Entity, type Memory, type MemoryEvent, type MemoryFilter, type MemoryLink, type MemorySourceRef, type MemoryStore, type Suppression, cosine, matches, terms } from '@feroxes/memory';
import type { Budget, BudgetStore, Counter, ReservationItem, UsageEvent, UsageFilter, UsageLedgerStore } from '@feroxes/metering';
import type { ApprovalRequest, ApprovalStatus, ApprovalStore, AuditEntry, AuditStore, StateChange, SystemStateStore } from '@feroxes/policy';
import { uuidv7 } from '@feroxes/shared';
import type { ArtifactStore, ToolCallRecord, ToolCallStore } from '@feroxes/tools';
import { type Db, fromJson, toJson } from './db.ts';

type Row = { data: string };

// ---------------------------------------------------------------- agent

export class SqliteAgentStore implements AgentStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async createSession(s: Session) {
    this.db.run('INSERT INTO sessions (id, data) VALUES (?, ?)', s.id, toJson(s));
  }
  async getSession(id: string) {
    const r = this.db.get<Row>('SELECT data FROM sessions WHERE id = ?', id);
    return r ? fromJson<Session>(r.data) : undefined;
  }
  async updateSession(s: Session) {
    this.db.run('UPDATE sessions SET data = ? WHERE id = ?', toJson(s), s.id);
  }
  async appendMessage(m: Omit<SessionMessage, 'seq'>) {
    return this.db.tx(() => {
      const seq = (this.db.get<{ n: number }>('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages WHERE session_id = ?', m.sessionId)!).n;
      const full: SessionMessage = { ...m, seq };
      this.db.run('INSERT INTO messages (id, session_id, seq, data) VALUES (?, ?, ?, ?)', m.id, m.sessionId, seq, toJson(full));
      return full;
    });
  }
  async messages(sessionId: string, opts: { afterSeq?: number } = {}) {
    return this.db.all<Row>('SELECT data FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq', sessionId, opts.afterSeq ?? 0).map((r) => fromJson<SessionMessage>(r.data));
  }
  async setRenderedContext(messageId: string, rendered: string, memoryIds: string[]) {
    const r = this.db.get<Row>('SELECT data FROM messages WHERE id = ?', messageId);
    if (!r) return;
    const m = fromJson<SessionMessage>(r.data);
    if (m.renderedContext !== undefined) return; // set once, never changed
    m.renderedContext = rendered;
    m.meta = { ...(m.meta ?? {}), memoryIds };
    this.db.run('UPDATE messages SET data = ? WHERE id = ?', toJson(m), messageId);
  }
  async putRun(r: Run) {
    this.db.run('INSERT INTO runs (id, session_id, status, data) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status, data = excluded.data', r.id, r.sessionId, r.status, toJson(r));
  }
  async getRun(id: string) {
    const r = this.db.get<Row>('SELECT data FROM runs WHERE id = ?', id);
    return r ? fromJson<Run>(r.data) : undefined;
  }
  async listRuns(f: { statuses?: RunStatus[]; sessionId?: string }) {
    return this.db
      .all<Row>('SELECT data FROM runs ORDER BY id')
      .map((r) => fromJson<Run>(r.data))
      .filter((r) => (!f.statuses || f.statuses.includes(r.status)) && (!f.sessionId || r.sessionId === f.sessionId));
  }
  async putStep(s: Step) {
    this.db.run('INSERT INTO steps (id, run_id, idx, data) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data', s.id, s.runId, s.idx, toJson(s));
  }
  async steps(runId: string) {
    return this.db.all<Row>('SELECT data FROM steps WHERE run_id = ? ORDER BY idx, id', runId).map((r) => fromJson<Step>(r.data));
  }
}

// ---------------------------------------------------------------- memory

const toBlob = (v: number[]) => new Uint8Array(new Float32Array(v).buffer);
const fromBlob = (b: Uint8Array) => Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));

export class SqliteMemoryStore implements MemoryStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async put(m: Memory) {
    this.db.tx(() => {
      this.db.run('INSERT INTO memories (id, status, updated_at, data) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, data = excluded.data', m.id, m.status, m.updatedAt, toJson(m));
      this.db.run('DELETE FROM memory_fts WHERE id = ?', m.id);
      this.db.run('INSERT INTO memory_fts (id, body) VALUES (?, ?)', m.id, `${m.title ?? ''} ${m.content}`);
    });
  }
  async get(id: string) {
    const r = this.db.get<Row>('SELECT data FROM memories WHERE id = ?', id);
    return r ? fromJson<Memory>(r.data) : undefined;
  }
  private load(f: MemoryFilter): Memory[] {
    const rows = f.statuses?.length
      ? this.db.all<Row>(`SELECT data FROM memories WHERE status IN (${f.statuses.map(() => '?').join(',')}) ORDER BY updated_at DESC`, ...f.statuses)
      : this.db.all<Row>('SELECT data FROM memories ORDER BY updated_at DESC');
    return rows.map((r) => fromJson<Memory>(r.data)).filter((m) => matches(m, f));
  }
  async list(f: MemoryFilter) {
    const rows = this.load(f);
    return f.limit ? rows.slice(0, f.limit) : rows;
  }
  async hardDelete(id: string) {
    this.db.tx(() => {
      for (const sql of ['DELETE FROM memories WHERE id = ?', 'DELETE FROM memory_fts WHERE id = ?', 'DELETE FROM embeddings WHERE memory_id = ?', 'DELETE FROM memory_sources WHERE memory_id = ?']) this.db.run(sql, id);
      this.db.run('DELETE FROM memory_links WHERE from_id = ? OR to_id = ?', id, id);
    });
  }
  async appendEvent(e: MemoryEvent) {
    this.db.run('INSERT INTO memory_events (id, memory_id, data) VALUES (?, ?, ?)', e.id, e.memoryId, toJson(e));
  }
  async events(memoryId: string) {
    return this.db.all<Row>('SELECT data FROM memory_events WHERE memory_id = ? ORDER BY id', memoryId).map((r) => fromJson<MemoryEvent>(r.data));
  }
  async getEvent(id: string) {
    const r = this.db.get<Row>('SELECT data FROM memory_events WHERE id = ?', id);
    return r ? fromJson<MemoryEvent>(r.data) : undefined;
  }
  async tombstoneEvents(memoryId: string) {
    for (const e of await this.events(memoryId)) {
      const { before: _b, after: _a, ...rest } = e;
      this.db.run('UPDATE memory_events SET data = ? WHERE id = ?', toJson({ ...rest, reason: e.type === 'deleted' ? e.reason : '[content removed after deletion]' }), e.id);
    }
  }
  async addSource(s: MemorySourceRef) {
    this.db.run('INSERT INTO memory_sources (memory_id, data) VALUES (?, ?)', s.memoryId, toJson(s));
  }
  async sources(memoryId: string) {
    return this.db.all<Row>('SELECT data FROM memory_sources WHERE memory_id = ?', memoryId).map((r) => fromJson<MemorySourceRef>(r.data));
  }
  async addLink(l: MemoryLink) {
    this.db.run('INSERT OR IGNORE INTO memory_links (from_id, to_id, type) VALUES (?, ?, ?)', l.fromId, l.toId, l.type);
  }
  async links(memoryId: string) {
    return this.db.all<{ from_id: string; to_id: string; type: MemoryLink['type'] }>('SELECT from_id, to_id, type FROM memory_links WHERE from_id = ? OR to_id = ?', memoryId, memoryId).map((r) => ({ fromId: r.from_id, toId: r.to_id, type: r.type }));
  }
  async putEmbedding(memoryId: string, spaceId: string, vector: number[]) {
    this.db.run('INSERT INTO embeddings (memory_id, space_id, vector) VALUES (?, ?, ?) ON CONFLICT (memory_id, space_id) DO UPDATE SET vector = excluded.vector', memoryId, spaceId, toBlob(vector));
  }
  async getEmbedding(memoryId: string, spaceId: string) {
    const r = this.db.get<{ vector: Uint8Array }>('SELECT vector FROM embeddings WHERE memory_id = ? AND space_id = ?', memoryId, spaceId);
    return r ? fromBlob(r.vector) : undefined;
  }
  /** Exact search over all vectors: fast enough for a personal store (~15 ms per 10k memories). */
  async vectorSearch(spaceId: string, query: number[], k: number, f: MemoryFilter) {
    const allowed = new Map(this.load(f).map((m) => [m.id, m]));
    const out: { memory: Memory; similarity: number }[] = [];
    for (const r of this.db.all<{ memory_id: string; vector: Uint8Array }>('SELECT memory_id, vector FROM embeddings WHERE space_id = ?', spaceId)) {
      const m = allowed.get(r.memory_id);
      if (m) out.push({ memory: m, similarity: cosine(query, fromBlob(r.vector)) });
    }
    return out.sort((a, b) => b.similarity - a.similarity).slice(0, k);
  }
  async textSearch(query: string, k: number, f: MemoryFilter) {
    const words = [...new Set(terms(query))];
    if (words.length === 0) return [];
    const match = words.map((w) => `"${w.replaceAll('"', '')}"`).join(' OR ');
    const allowed = new Map(this.load(f).map((m) => [m.id, m]));
    return this.db
      .all<{ id: string; rank: number }>('SELECT id, bm25(memory_fts) AS rank FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?', match, k * 4)
      .filter((r) => allowed.has(r.id))
      .slice(0, k)
      .map((r) => ({ memory: allowed.get(r.id)!, score: -r.rank }));
  }
  async putEntity(e: Entity) {
    this.db.run('INSERT INTO entities (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data', e.id, toJson(e));
  }
  async getEntity(id: string) {
    const r = this.db.get<Row>('SELECT data FROM entities WHERE id = ?', id);
    return r ? fromJson<Entity>(r.data) : undefined;
  }
  async listEntities() {
    return this.db.all<Row>('SELECT data FROM entities').map((r) => fromJson<Entity>(r.data));
  }
  async findEntities(text: string) {
    const lower = ` ${text.toLowerCase().replace(/[?.!,;:'"]/g, ' ')} `;
    return (await this.listEntities()).filter((e) => [e.name, ...e.aliases].some((n) => lower.includes(` ${n.toLowerCase()} `)));
  }
  async addSuppression(s: Suppression) {
    this.db.run('INSERT INTO suppressions (id, data) VALUES (?, ?)', s.id, toJson(s));
  }
  async suppressions() {
    return this.db.all<Row>('SELECT data FROM suppressions').map((r) => fromJson<Suppression>(r.data));
  }
  async saveCore(c: CoreSnapshot) {
    this.db.run('INSERT INTO core_snapshots (id, generated_at, data) VALUES (?, ?, ?)', c.id, c.generatedAt, toJson(c));
  }
  async latestCore() {
    const r = this.db.get<Row>('SELECT data FROM core_snapshots ORDER BY generated_at DESC, id DESC LIMIT 1');
    return r ? fromJson<CoreSnapshot>(r.data) : undefined;
  }
  async getNotes() {
    return this.db.get<{ value: string }>("SELECT value FROM kv WHERE key = 'core_notes'")?.value ?? '';
  }
  async setNotes(notes: string) {
    this.db.run("INSERT INTO kv (key, value) VALUES ('core_notes', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", notes);
  }
}

// ---------------------------------------------------------------- metering

export class SqliteUsageLedgerStore implements UsageLedgerStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  async append(e: UsageEvent) {
    this.db.run('INSERT INTO usage_events (id, ts, data) VALUES (?, ?, ?)', e.id, e.ts, toJson(e));
  }
  async query(f: UsageFilter) {
    return this.db
      .all<Row>('SELECT data FROM usage_events WHERE ts >= ? AND ts < ? ORDER BY ts, id', f.from ?? 0, f.to ?? Number.MAX_SAFE_INTEGER)
      .map((r) => fromJson<UsageEvent>(r.data))
      .filter((e) => (!f.providerId || e.providerId === f.providerId) && (!f.modelId || e.modelId === f.modelId) && (!f.route || e.route === f.route) && (!f.priority || e.priority === f.priority) && (!f.runId || e.runId === f.runId));
  }
}

interface StoredReservation {
  requestId: string;
  items: ReservationItem[];
}

export class SqliteBudgetStore implements BudgetStore {
  private readonly db: Db;
  constructor(db: Db, seed: Budget[] = []) {
    this.db = db;
    // Config seeds budgets the first time; later edits by the owner are kept.
    for (const b of seed) this.db.run('INSERT OR IGNORE INTO budgets (id, data) VALUES (?, ?)', b.id, toJson(b));
  }
  async listBudgets() {
    return this.db.all<Row>('SELECT data FROM budgets').map((r) => fromJson<Budget>(r.data)).filter((b) => b.enabled);
  }
  saveBudget(b: Budget) {
    this.db.run('INSERT INTO budgets (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data', b.id, toJson(b));
  }
  private counterRow(budgetId: string, periodStart: number): Counter {
    this.db.run('INSERT OR IGNORE INTO budget_counters (budget_id, period_start) VALUES (?, ?)', budgetId, periodStart);
    const r = this.db.get<{ spent: number; reserved: number }>('SELECT spent, reserved FROM budget_counters WHERE budget_id = ? AND period_start = ?', budgetId, periodStart)!;
    return { spent: Number(r.spent), reserved: Number(r.reserved) };
  }
  async tryReserve(input: { reservationId: string; requestId: string; items: ReservationItem[]; expiresAt: number }) {
    return this.db.tx((): { ok: true } | { ok: false; budgetId: string; counter: Counter } => {
      for (const item of [...input.items].sort((a, b) => a.budgetId.localeCompare(b.budgetId))) {
        const c = this.counterRow(item.budgetId, item.periodStart);
        if (c.spent + c.reserved + item.amount > item.effectiveLimit) return { ok: false, budgetId: item.budgetId, counter: c };
      }
      for (const item of input.items) this.db.run('UPDATE budget_counters SET reserved = reserved + ? WHERE budget_id = ? AND period_start = ?', item.amount, item.budgetId, item.periodStart);
      this.db.run('INSERT INTO reservations (id, status, expires_at, data) VALUES (?, ?, ?, ?)', input.reservationId, 'active', input.expiresAt, toJson({ requestId: input.requestId, items: input.items } satisfies StoredReservation));
      return { ok: true };
    });
  }
  private finish(reservationId: string, status: 'settled' | 'released' | 'expired', actual?: number) {
    const r = this.db.get<{ status: string; data: string }>('SELECT status, data FROM reservations WHERE id = ?', reservationId);
    if (!r || r.status !== 'active') return [];
    const { items } = fromJson<StoredReservation>(r.data);
    this.db.run('UPDATE reservations SET status = ? WHERE id = ?', status, reservationId);
    return items.map((item) => {
      this.db.run('UPDATE budget_counters SET reserved = MAX(0, reserved - ?), spent = spent + ? WHERE budget_id = ? AND period_start = ?', item.amount, actual ?? 0, item.budgetId, item.periodStart);
      return { budgetId: item.budgetId, periodStart: item.periodStart, counter: this.counterRow(item.budgetId, item.periodStart) };
    });
  }
  async settle(reservationId: string, actual: number) {
    return this.db.tx(() => this.finish(reservationId, 'settled', actual));
  }
  async release(reservationId: string) {
    this.db.tx(() => void this.finish(reservationId, 'released'));
  }
  async expire(now: number) {
    return this.db.tx(() => {
      const ids = this.db.all<{ id: string }>("SELECT id FROM reservations WHERE status = 'active' AND expires_at <= ?", now);
      for (const { id } of ids) this.finish(id, 'expired');
      return ids.length;
    });
  }
  async counter(budgetId: string, periodStart: number) {
    return this.counterRow(budgetId, periodStart);
  }
  async markAlert(budgetId: string, periodStart: number, threshold: number) {
    return Number(this.db.run('INSERT OR IGNORE INTO budget_alerts (budget_id, period_start, threshold) VALUES (?, ?, ?)', budgetId, periodStart, threshold).changes) > 0;
  }
  activeReservationCount(): number {
    return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reservations WHERE status = 'active'")!.n);
  }
}

// ---------------------------------------------------------------- policy

export class SqliteAuditStore implements AuditStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  async append(e: AuditEntry) {
    this.db.run('INSERT INTO audit (seq, data) VALUES (?, ?)', e.seq, toJson(e));
  }
  async last() {
    const r = this.db.get<Row>('SELECT data FROM audit ORDER BY seq DESC LIMIT 1');
    return r ? fromJson<AuditEntry>(r.data) : undefined;
  }
  async *all() {
    for (const r of this.db.all<Row>('SELECT data FROM audit ORDER BY seq')) yield fromJson<AuditEntry>(r.data);
  }
  async query(f: { runId?: string; action?: string; limit?: number }) {
    const rows = this.db.all<Row>('SELECT data FROM audit ORDER BY seq').map((r) => fromJson<AuditEntry>(r.data)).filter((e) => (!f.runId || e.runId === f.runId) && (!f.action || e.action === f.action));
    return f.limit ? rows.slice(-f.limit) : rows;
  }
}

export class SqliteApprovalStore implements ApprovalStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  async put(a: ApprovalRequest) {
    this.db.run('INSERT INTO approvals (id, status, run_id, data) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status, data = excluded.data', a.id, a.status, a.runId, toJson(a));
  }
  async get(id: string) {
    const r = this.db.get<Row>('SELECT data FROM approvals WHERE id = ?', id);
    return r ? fromJson<ApprovalRequest>(r.data) : undefined;
  }
  async list(f: { status?: ApprovalStatus; runId?: string }) {
    return this.db.all<Row>('SELECT data FROM approvals ORDER BY id').map((r) => fromJson<ApprovalRequest>(r.data)).filter((a) => (!f.status || a.status === f.status) && (!f.runId || a.runId === f.runId));
  }
}

export class SqliteSystemStateStore implements SystemStateStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  async load() {
    const r = this.db.get<Row>('SELECT data FROM system_state ORDER BY id DESC LIMIT 1');
    return r ? { state: fromJson<StateChange>(r.data).state } : undefined;
  }
  async save(change: StateChange) {
    this.db.run('INSERT INTO system_state (data) VALUES (?)', toJson(change));
  }
}

// ---------------------------------------------------------------- tools

export class SqliteToolCallStore implements ToolCallStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  async byKey(key: string) {
    const r = this.db.get<Row>('SELECT data FROM tool_calls WHERE idempotency_key = ?', key);
    return r ? fromJson<ToolCallRecord>(r.data) : undefined;
  }
  async put(r: ToolCallRecord) {
    this.db.run('INSERT INTO tool_calls (idempotency_key, run_id, data) VALUES (?, ?, ?) ON CONFLICT (idempotency_key) DO UPDATE SET data = excluded.data', r.idempotencyKey, r.runId, toJson(r));
  }
  async list(runId: string) {
    return this.db.all<Row>('SELECT data FROM tool_calls WHERE run_id = ?', runId).map((r) => fromJson<ToolCallRecord>(r.data));
  }
}

export class SqliteArtifactStore implements ArtifactStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  async save(runId: string, content: string, mime: string) {
    const id = uuidv7();
    this.db.run('INSERT INTO artifacts (id, run_id, mime, content) VALUES (?, ?, ?, ?)', id, runId, mime, content);
    return id;
  }
  async read(id: string) {
    return this.db.get<{ content: string }>('SELECT content FROM artifacts WHERE id = ?', id)?.content;
  }
}

/** Generic versioned documents (self-model, goals, skills, devices…): kind + id → JSON. */
export class SqliteDocStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  put<T extends { id: string }>(kind: string, doc: T, updatedAt = Date.now()) {
    this.db.run('INSERT INTO docs (kind, id, updated_at, data) VALUES (?, ?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data', kind, doc.id, updatedAt, toJson(doc));
  }
  get<T>(kind: string, id: string): T | undefined {
    const r = this.db.get<Row>('SELECT data FROM docs WHERE kind = ? AND id = ?', kind, id);
    return r ? fromJson<T>(r.data) : undefined;
  }
  list<T>(kind: string): T[] {
    return this.db.all<Row>('SELECT data FROM docs WHERE kind = ? ORDER BY updated_at, id', kind).map((r) => fromJson<T>(r.data));
  }
  delete(kind: string, id: string) {
    this.db.run('DELETE FROM docs WHERE kind = ? AND id = ?', kind, id);
  }
}
