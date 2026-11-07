import {
  type Clock,
  FeroxesError,
  type PriorityClass,
  type Sensitivity,
  contentHash,
  sensitivityRank,
  systemClock,
  uuidv7,
} from '@feroxes/shared';
import { approxTokens, clamp01, confidenceWeight, cosine, importanceWeight, mmr, recencyWeight, rrf } from './scoring.ts';
import { containsSecret } from './secrets.ts';
import type { CoreSnapshot, MemoryFilter, MemoryStore } from './store.ts';
import {
  type Actor,
  type Entity,
  LAYER_OF,
  type Memory,
  type MemoryEvent,
  type MemoryKind,
  type MemoryLayer,
  type MemorySourceKind,
  type MemorySourceRef,
  type ScoredMemory,
} from './types.ts';

/** Turns text into vectors in one embedding space. Backed by the router in production. */
export interface Embedder {
  readonly spaceId: string;
  embed(texts: string[], priority: PriorityClass): Promise<number[][]>;
}

export interface RememberInput {
  content: string;
  kind: MemoryKind;
  title?: string;
  structured?: Record<string, unknown>;
  importance?: number;
  confidence?: number;
  sensitivity?: Sensitivity;
  pinned?: boolean;
  source?: MemorySourceKind;
  occurredAt?: number;
  validFrom?: number;
  status?: Memory['status'];
  entities?: { name: string; kind?: Entity['kind']; aliases?: string[] }[];
  sources?: Omit<MemorySourceRef, 'memoryId'>[];
}

export interface MemoryQuery {
  text: string;
  limit?: number;
  layers?: MemoryLayer[];
  kinds?: MemoryKind[];
  maxSensitivity?: Sensitivity;
  /** Include superseded and expired facts, and ignore recency ("what did I think last year"). */
  historical?: boolean;
  priority?: PriorityClass;
}

export interface MemoryContext {
  core: string;
  retrieved: ScoredMemory[];
  /** The block sent with the latest user message; memory ids let the model cite them. */
  rendered: string;
  usedIds: string[];
  tokens: { core: number; retrieved: number };
}

export class SecretRejectedError extends FeroxesError {
  constructor() {
    super('secret_rejected', 'This looks like a password, key or card number. Feroxes keeps credentials only in the encrypted vault (Settings → Security), never in memory.');
  }
}

export class SuppressedError extends FeroxesError {
  constructor() {
    super('suppressed', 'The owner asked Feroxes to forget this, so it is not stored again.');
  }
}

const SUPPRESSION_SIMILARITY = 0.9;

export class MemoryService {
  readonly store: MemoryStore;
  private readonly embedder: Embedder | undefined;
  private readonly clock: Clock;
  private readonly listeners = new Set<(e: MemoryEvent) => void>();

  constructor(deps: { store: MemoryStore; embedder?: Embedder; clock?: Clock }) {
    this.store = deps.store;
    this.embedder = deps.embedder;
    this.clock = deps.clock ?? systemClock;
  }

  onEvent(listener: (e: MemoryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------- writes ----------

  async remember(input: RememberInput, actor: Actor, opts: { runId?: string; reason?: string; priority?: PriorityClass } = {}): Promise<Memory> {
    const content = input.content.trim();
    if (!content) throw new FeroxesError('empty_memory', 'Memory content is empty');
    if (containsSecret(content)) throw new SecretRejectedError();
    const ownerAsserted = (input.source ?? (actor === 'owner' ? 'owner_asserted' : 'extracted')) === 'owner_asserted';
    const vector = await this.embedOne(content, opts.priority ?? 'routine');
    if (!ownerAsserted && (await this.isSuppressed(content, vector))) throw new SuppressedError();

    const now = this.clock.now();
    const entityIds = await this.resolveEntities(input.entities ?? []);
    const memory: Memory = {
      id: uuidv7(now),
      layer: LAYER_OF[input.kind],
      kind: input.kind,
      ...(input.title ? { title: input.title } : {}),
      content,
      ...(input.structured ? { structured: input.structured } : {}),
      importance: clamp01(input.importance ?? (ownerAsserted ? 0.7 : 0.5)),
      confidence: clamp01(input.confidence ?? (ownerAsserted ? 1 : 0.6)),
      evidenceCount: 1,
      sensitivity: input.sensitivity ?? 'normal',
      status: input.status ?? 'active',
      pinned: input.pinned ?? false,
      source: input.source ?? (actor === 'owner' ? 'owner_asserted' : 'extracted'),
      ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
      validFrom: input.validFrom ?? now,
      contentHash: contentHash(content),
      version: 1,
      accessCount: 0,
      createdAt: now,
      updatedAt: now,
      entityIds,
    };
    await this.store.put(memory);
    if (vector && this.embedder) await this.store.putEmbedding(memory.id, this.embedder.spaceId, vector);
    for (const s of input.sources ?? []) await this.store.addSource({ ...s, memoryId: memory.id });
    await this.event(memory.id, 'created', actor, opts.reason ?? 'created', undefined, memory, opts.runId);
    return memory;
  }

  async update(id: string, patch: Partial<Pick<Memory, 'content' | 'title' | 'kind' | 'importance' | 'confidence' | 'sensitivity' | 'structured' | 'validFrom' | 'validTo' | 'occurredAt'>>, actor: Actor, reason: string, runId?: string): Promise<Memory> {
    const before = await this.require(id);
    if (patch.content !== undefined && containsSecret(patch.content)) throw new SecretRejectedError();
    const now = this.clock.now();
    const after: Memory = { ...before, ...patch, version: before.version + 1, updatedAt: now };
    if (patch.kind) after.layer = LAYER_OF[patch.kind];
    if (patch.content !== undefined) {
      after.content = patch.content.trim();
      after.contentHash = contentHash(after.content);
    }
    // An owner edit makes the memory owner-asserted.
    if (actor === 'owner') {
      after.source = 'owner_asserted';
      if (patch.confidence === undefined) after.confidence = 1;
    }
    await this.store.put(after);
    if (patch.content !== undefined && this.embedder) {
      const v = await this.embedOne(after.content, 'routine');
      if (v) await this.store.putEmbedding(id, this.embedder.spaceId, v);
    }
    await this.event(id, 'updated', actor, reason, diff(before, after), diff(after, before), runId);
    return after;
  }

  /** A newer fact replaces an older one; the old one stays in history with an end date. */
  async supersede(oldId: string, input: RememberInput, actor: Actor, reason: string, runId?: string): Promise<Memory> {
    const old = await this.require(oldId);
    const now = this.clock.now();
    const created = await this.remember({ ...input, validFrom: input.validFrom ?? now }, actor, { ...(runId ? { runId } : {}), reason });
    const withLink: Memory = { ...created, supersedesId: oldId };
    await this.store.put(withLink);
    const ended: Memory = { ...old, status: 'superseded', validTo: now, updatedAt: now, version: old.version + 1 };
    await this.store.put(ended);
    await this.store.addLink({ fromId: created.id, toId: oldId, type: 'contradicts' });
    await this.event(oldId, 'superseded', actor, reason, { status: old.status, validTo: old.validTo }, { status: 'superseded', validTo: now, supersedesId: created.id } as Partial<Memory>, runId);
    return withLink;
  }

  /** The same fact seen again: more evidence, more confidence (capped for inferred facts). */
  async addEvidence(id: string, actor: Actor, reason: string, source?: Omit<MemorySourceRef, 'memoryId'>): Promise<Memory> {
    const before = await this.require(id);
    const cap = before.source === 'owner_asserted' ? 1 : 0.95;
    const after: Memory = { ...before, evidenceCount: before.evidenceCount + 1, confidence: Math.min(cap, 1 - (1 - before.confidence) * 0.7), updatedAt: this.clock.now() };
    if (before.status === 'archived' && after.confidence >= 0.5 && before.structured?.lowConfidence) after.status = 'active';
    await this.store.put(after);
    if (source) await this.store.addSource({ ...source, memoryId: id });
    await this.event(id, 'evidence', actor, reason, { confidence: before.confidence, evidenceCount: before.evidenceCount, status: before.status }, { confidence: after.confidence, evidenceCount: after.evidenceCount, status: after.status });
    return after;
  }

  async setPinned(id: string, pinned: boolean, actor: Actor): Promise<void> {
    const m = await this.require(id);
    if (m.pinned === pinned) return;
    await this.store.put({ ...m, pinned, updatedAt: this.clock.now() });
    await this.event(id, pinned ? 'pinned' : 'unpinned', actor, pinned ? 'pinned' : 'unpinned', { pinned: m.pinned }, { pinned });
  }

  async archive(id: string, actor: Actor, reason = 'archived'): Promise<void> {
    const m = await this.require(id);
    await this.store.put({ ...m, status: 'archived', updatedAt: this.clock.now() });
    await this.event(id, 'archived', actor, reason, { status: m.status }, { status: 'archived' });
  }

  async restore(id: string, actor: Actor): Promise<void> {
    const m = await this.require(id);
    await this.store.put({ ...m, status: 'active', updatedAt: this.clock.now() });
    await this.event(id, 'restored', actor, 'restored', { status: m.status }, { status: 'active' });
  }

  /**
   * Permanent deletion (owner only): removes content, embeddings, sources and links; history keeps
   * a tombstone without content. With `suppress`, the fact is blocked from being learned again.
   */
  async delete(id: string, opts: { suppress: boolean }, actor: Actor): Promise<void> {
    if (actor !== 'owner') throw new FeroxesError('owner_only', 'Only the owner can delete memories permanently.');
    const m = await this.require(id);
    if (opts.suppress) {
      const vector = this.embedder ? await this.store.getEmbedding(id, this.embedder.spaceId) : undefined;
      await this.store.addSuppression({
        id: uuidv7(),
        contentHash: m.contentHash,
        ...(vector && this.embedder ? { embedding: vector, spaceId: this.embedder.spaceId } : {}),
        pattern: m.content.slice(0, 80),
        reason: 'owner deleted with "do not re-learn"',
        createdAt: this.clock.now(),
      });
    }
    await this.store.hardDelete(id);
    await this.store.tombstoneEvents(id);
    await this.event(id, 'deleted', actor, opts.suppress ? 'deleted permanently; re-learning blocked' : 'deleted permanently');
  }

  /** Reverts one change. Deletions can't be undone because their content is gone. */
  async undo(eventId: string, actor: Actor): Promise<Memory> {
    const e = await this.store.getEvent(eventId);
    if (!e) throw new FeroxesError('not_found', `event ${eventId} not found`);
    if (e.type === 'deleted') throw new FeroxesError('cannot_undo', 'A permanent deletion cannot be undone.');
    const m = await this.require(e.memoryId);
    if (e.type === 'created') {
      await this.archive(m.id, actor, `undo of ${eventId}`);
      return (await this.store.get(m.id))!;
    }
    const restored: Memory = { ...m, ...(e.before ?? {}), version: m.version + 1, updatedAt: this.clock.now() };
    if (e.type === 'superseded') delete restored.validTo;
    if (restored.content !== m.content) restored.contentHash = contentHash(restored.content);
    await this.store.put(restored);
    if (restored.content !== m.content && this.embedder) {
      const v = await this.embedOne(restored.content, 'routine');
      if (v) await this.store.putEmbedding(m.id, this.embedder.spaceId, v);
    }
    await this.event(m.id, 'updated', actor, `undo of ${e.type} (${eventId})`, diff(m, restored), diff(restored, m));
    return restored;
  }

  async isSuppressed(content: string, vector?: number[]): Promise<boolean> {
    const hash = contentHash(content);
    for (const s of await this.store.suppressions()) {
      if (s.contentHash === hash) return true;
      if (vector && s.embedding && s.spaceId === this.embedder?.spaceId && cosine(vector, s.embedding) >= SUPPRESSION_SIMILARITY) return true;
    }
    return false;
  }

  // ---------- reads ----------

  async get(id: string) {
    const memory = await this.store.get(id);
    if (!memory) return undefined;
    return { memory, sources: await this.store.sources(id), events: await this.store.events(id), links: await this.store.links(id) };
  }

  history(id: string) {
    return this.store.events(id);
  }

  /** Hybrid retrieval (architecture §7.4, Phase 1 plan §7.9). */
  async search(q: MemoryQuery): Promise<ScoredMemory[]> {
    const now = this.clock.now();
    const limit = q.limit ?? 10;
    const filter: MemoryFilter = {
      statuses: q.historical ? ['active', 'superseded'] : ['active'],
      ...(q.historical ? {} : { validAt: now }),
      ...(q.layers ? { layers: q.layers } : {}),
      ...(q.kinds ? { kinds: q.kinds } : {}),
    };
    const pool = 50;

    const ranks = new Map<string, { memory: Memory; vector?: number; text?: number; entity?: number }>();
    const note = (m: Memory, key: 'vector' | 'text' | 'entity', rank: number) => {
      const r = ranks.get(m.id) ?? { memory: m };
      if (r[key] === undefined) r[key] = rank;
      ranks.set(m.id, r);
    };

    const queryVector = await this.embedOne(q.text, q.priority ?? 'interactive');
    if (queryVector && this.embedder) {
      const hits = await this.store.vectorSearch(this.embedder.spaceId, queryVector, pool, filter);
      hits.filter((h) => h.similarity > 0.2).forEach((h, i) => note(h.memory, 'vector', i + 1));
    }
    (await this.store.textSearch(q.text, pool, filter)).forEach((h, i) => note(h.memory, 'text', i + 1));
    const entities = await this.store.findEntities(q.text);
    if (entities.length > 0) {
      const seen = new Set<string>();
      let rank = 0;
      for (const e of entities) {
        for (const m of await this.store.list({ ...filter, entityId: e.id, limit: pool })) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            note(m, 'entity', ++rank);
          }
        }
      }
    }

    const maxSens = q.maxSensitivity ?? 'secret';
    const scored: ScoredMemory[] = [];
    for (const r of ranks.values()) {
      if (sensitivityRank(r.memory.sensitivity) > sensitivityRank(maxSens)) continue;
      const base = rrf([r.vector, r.text, r.entity]);
      const importance = importanceWeight(r.memory);
      const recency = q.historical ? 1 : recencyWeight(r.memory, now);
      const confidence = confidenceWeight(r.memory);
      const total = base * importance * recency * confidence;
      scored.push({
        memory: r.memory,
        score: total,
        breakdown: { rrf: base, ranks: { ...(r.vector ? { vector: r.vector } : {}), ...(r.text ? { text: r.text } : {}), ...(r.entity ? { entity: r.entity } : {}) }, importance, recency, confidence, total },
      });
    }
    scored.sort((a, b) => b.score - a.score);

    const top = scored.slice(0, 30);
    const withVectors = await Promise.all(top.map(async (s) => ({ item: s, score: s.score, ...(this.embedder ? { vector: await this.store.getEmbedding(s.memory.id, this.embedder.spaceId) } : {}) })));
    const picked = mmr(withVectors.map((w) => ({ item: w.item, score: w.score, ...(w.vector ? { vector: w.vector } : {}) })), limit, 0.7);
    void this.touch(picked.map((p) => p.memory.id));
    return picked;
  }

  /** Core block + retrieved memories for one prompt (architecture §7.6). */
  async buildContext(req: { query: string; maxSensitivity: Sensitivity; budgets?: { core?: number; retrieved?: number }; excludeIds?: string[] }): Promise<MemoryContext> {
    const coreBudget = req.budgets?.core ?? 1200;
    const retrievedBudget = req.budgets?.retrieved ?? 2500;
    const core = await this.coreBlock(req.maxSensitivity, coreBudget);
    const coreIds = new Set(core.ids);
    const hits = (await this.search({ text: req.query, limit: 12, maxSensitivity: req.maxSensitivity })).filter((h) => !coreIds.has(h.memory.id) && !req.excludeIds?.includes(h.memory.id));

    const lines: string[] = [];
    const used: ScoredMemory[] = [];
    let tokens = 0;
    for (const h of hits) {
      const line = `[m:${h.memory.id.slice(-8)}] (${h.memory.kind}${h.memory.occurredAt ? `, ${new Date(h.memory.occurredAt).toISOString().slice(0, 10)}` : ''}) ${h.memory.content}`;
      const t = approxTokens(line);
      if (tokens + t > retrievedBudget) break;
      lines.push(line);
      used.push(h);
      tokens += t;
    }
    const rendered = lines.length ? `<memories>\nRelevant memories (cite as [m:id] when you rely on one):\n${lines.join('\n')}\n</memories>` : '';
    return { core: core.text, retrieved: used, rendered, usedIds: used.map((u) => u.memory.id), tokens: { core: approxTokens(core.text), retrieved: tokens } };
  }

  /**
   * The always-in-prompt profile. Uses the latest consolidated snapshot when present (refreshed
   * nightly), otherwise assembles one from pinned memories, rules and important facts.
   */
  async coreBlock(maxSensitivity: Sensitivity, budget = 1200): Promise<{ text: string; ids: string[] }> {
    const snapshot = await this.store.latestCore();
    const notes = await this.store.getNotes();
    const built = await this.assembleCore(maxSensitivity, budget - approxTokens(notes));
    // A snapshot built under a looser sensitivity limit can't be reused for a stricter provider.
    const text = snapshot && maxSensitivity === 'secret' ? snapshot.content : built.text;
    const ids = snapshot && maxSensitivity === 'secret' ? snapshot.sourceMemoryIds : built.ids;
    return { text: [text, notes ? `Owner's notes:\n${notes}` : ''].filter(Boolean).join('\n\n'), ids };
  }

  async assembleCore(maxSensitivity: Sensitivity, budget: number): Promise<{ text: string; ids: string[] }> {
    const now = this.clock.now();
    const all = (await this.store.list({ statuses: ['active'], validAt: now })).filter((m) => sensitivityRank(m.sensitivity) <= sensitivityRank(maxSensitivity));
    const rank = (m: Memory) => (m.pinned ? 10 : 0) + (m.kind === 'rule' ? 5 : 0) + m.importance * m.confidence;
    const candidates = all.filter((m) => m.pinned || m.kind === 'rule' || m.kind === 'style' || (m.layer === 'semantic' && m.importance * m.confidence >= 0.42)).sort((a, b) => rank(b) - rank(a));

    const groups: [string, (m: Memory) => boolean][] = [
      ['Standing rules', (m) => m.kind === 'rule'],
      ['Communication style', (m) => m.kind === 'style'],
      ['People and relationships', (m) => m.kind === 'relationship'],
      ['Preferences', (m) => m.kind === 'preference'],
      ['Goals and commitments', (m) => m.kind === 'goal' || m.kind === 'commitment'],
      ['Facts', (m) => true],
    ];
    const ids: string[] = [];
    const sections = new Map<string, string[]>();
    let tokens = 0;
    for (const m of candidates) {
      // Ids make core memories citable too, so the UI can show which ones an answer used.
      const line = `- ${m.content} [m:${m.id.slice(-8)}]`;
      const t = approxTokens(line);
      if (tokens + t > budget) continue;
      const group = groups.find(([, f]) => f(m))![0];
      sections.set(group, [...(sections.get(group) ?? []), line]);
      ids.push(m.id);
      tokens += t;
    }
    const text = groups.filter(([g]) => sections.has(g)).map(([g]) => `${g}:\n${sections.get(g)!.join('\n')}`).join('\n\n');
    return { text, ids };
  }

  async regenerateCore(budget = 1200): Promise<CoreSnapshot> {
    const built = await this.assembleCore('secret', budget);
    const snapshot: CoreSnapshot = { id: uuidv7(), content: built.text, tokenCount: approxTokens(built.text), sourceMemoryIds: built.ids, generatedAt: this.clock.now() };
    await this.store.saveCore(snapshot);
    return snapshot;
  }

  // ---------- helpers ----------

  async resolveEntities(list: { name: string; kind?: Entity['kind']; aliases?: string[] }[]): Promise<string[]> {
    const ids: string[] = [];
    const existing = await this.store.listEntities();
    for (const e of list) {
      const name = e.name.trim();
      if (!name || /^(owner|me|i|user)$/i.test(name)) continue;
      const lower = name.toLowerCase();
      const found = existing.find((x) => x.name.toLowerCase() === lower || x.aliases.some((a) => a.toLowerCase() === lower));
      if (found) {
        const aliases = [...new Set([...found.aliases, ...(e.aliases ?? [])])];
        if (aliases.length !== found.aliases.length) await this.store.putEntity({ ...found, aliases, updatedAt: this.clock.now() });
        ids.push(found.id);
      } else {
        const entity: Entity = { id: uuidv7(), kind: e.kind ?? 'thing', name, aliases: e.aliases ?? [], createdAt: this.clock.now(), updatedAt: this.clock.now() };
        await this.store.putEntity(entity);
        existing.push(entity);
        ids.push(entity.id);
      }
    }
    return [...new Set(ids)];
  }

  get spaceId(): string | undefined {
    return this.embedder?.spaceId;
  }

  async embeddingOf(memoryId: string): Promise<number[] | undefined> {
    return this.embedder ? this.store.getEmbedding(memoryId, this.embedder.spaceId) : undefined;
  }

  async embedOne(text: string, priority: PriorityClass): Promise<number[] | undefined> {
    if (!this.embedder) return undefined;
    const [v] = await this.embedder.embed([text], priority);
    return v;
  }

  private async require(id: string): Promise<Memory> {
    const m = await this.store.get(id);
    if (!m) throw new FeroxesError('not_found', `memory ${id} not found`);
    return m;
  }

  private async touch(ids: string[]) {
    const now = this.clock.now();
    for (const id of ids) {
      const m = await this.store.get(id);
      if (m) await this.store.put({ ...m, accessCount: m.accessCount + 1, lastAccessedAt: now });
    }
  }

  private async event(memoryId: string, type: MemoryEvent['type'], actor: Actor, reason: string, before?: Partial<Memory>, after?: Partial<Memory>, runId?: string) {
    const e: MemoryEvent = { id: uuidv7(), memoryId, type, actor, reason, createdAt: this.clock.now(), ...(before ? { before } : {}), ...(after ? { after } : {}), ...(runId ? { runId } : {}) };
    await this.store.appendEvent(e);
    for (const l of this.listeners) l(e);
  }
}

/** Fields of `a` that differ from `b` (used to store compact before/after snapshots). */
function diff(a: Memory, b: Memory): Partial<Memory> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(a) as (keyof Memory)[]) {
    if (key === 'updatedAt' || key === 'version' || key === 'accessCount' || key === 'lastAccessedAt') continue;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) out[key] = a[key];
  }
  for (const key of Object.keys(b) as (keyof Memory)[]) {
    if (!(key in a) && key !== 'updatedAt') out[key] = undefined;
  }
  return out as Partial<Memory>;
}
