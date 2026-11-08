import { cosine, terms } from './scoring.ts';
import type { Entity, Memory, MemoryEvent, MemoryLayer, MemoryLink, MemorySourceRef, MemoryStatus, Suppression } from './types.ts';

export interface MemoryFilter {
  layers?: MemoryLayer[];
  kinds?: Memory['kind'][];
  statuses?: MemoryStatus[];
  entityId?: string;
  /** Only memories valid at this instant (validFrom ≤ t < validTo). */
  validAt?: number;
  pinned?: boolean;
  limit?: number;
}

/**
 * Storage port for the memory engine. The Postgres implementation maps these onto the
 * tables in Phase 1 plan §5.3 (HNSW for `vectorSearch`, tsvector for `textSearch`,
 * pg_trgm for entity names). This in-memory version backs tests and the demo.
 */
export interface MemoryStore {
  put(m: Memory): Promise<void>;
  get(id: string): Promise<Memory | undefined>;
  list(filter: MemoryFilter): Promise<Memory[]>;
  hardDelete(id: string): Promise<void>;

  appendEvent(e: MemoryEvent): Promise<void>;
  events(memoryId: string): Promise<MemoryEvent[]>;
  getEvent(id: string): Promise<MemoryEvent | undefined>;
  /** Replaces event payloads with a tombstone when a memory is deleted permanently. */
  tombstoneEvents(memoryId: string): Promise<void>;

  addSource(s: MemorySourceRef): Promise<void>;
  sources(memoryId: string): Promise<MemorySourceRef[]>;
  addLink(l: MemoryLink): Promise<void>;
  links(memoryId: string): Promise<MemoryLink[]>;

  putEmbedding(memoryId: string, spaceId: string, vector: number[]): Promise<void>;
  getEmbedding(memoryId: string, spaceId: string): Promise<number[] | undefined>;
  vectorSearch(spaceId: string, query: number[], k: number, filter: MemoryFilter): Promise<{ memory: Memory; similarity: number }[]>;
  textSearch(query: string, k: number, filter: MemoryFilter): Promise<{ memory: Memory; score: number }[]>;

  putEntity(e: Entity): Promise<void>;
  getEntity(id: string): Promise<Entity | undefined>;
  findEntities(text: string): Promise<Entity[]>;
  listEntities(): Promise<Entity[]>;

  addSuppression(s: Suppression): Promise<void>;
  suppressions(): Promise<Suppression[]>;

  saveCore(snapshot: CoreSnapshot): Promise<void>;
  latestCore(): Promise<CoreSnapshot | undefined>;
  getNotes(): Promise<string>;
  setNotes(notes: string): Promise<void>;
}

export interface CoreSnapshot {
  id: string;
  content: string;
  tokenCount: number;
  sourceMemoryIds: string[];
  generatedAt: number;
}

export function matches(m: Memory, f: MemoryFilter): boolean {
  if (f.layers && !f.layers.includes(m.layer)) return false;
  if (f.kinds && !f.kinds.includes(m.kind)) return false;
  if (f.statuses && !f.statuses.includes(m.status)) return false;
  if (f.entityId && !m.entityIds.includes(f.entityId)) return false;
  if (f.pinned !== undefined && m.pinned !== f.pinned) return false;
  if (f.validAt !== undefined) {
    if (m.validFrom !== undefined && m.validFrom > f.validAt) return false;
    if (m.validTo !== undefined && m.validTo <= f.validAt) return false;
  }
  return true;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly memories = new Map<string, Memory>();
  private readonly eventsById = new Map<string, MemoryEvent>();
  private readonly eventsByMemory = new Map<string, string[]>();
  private readonly sourceRows: MemorySourceRef[] = [];
  private readonly linkRows: MemoryLink[] = [];
  private readonly vectors = new Map<string, Map<string, number[]>>(); // space → memory → vector
  private readonly entities = new Map<string, Entity>();
  private readonly suppressionRows: Suppression[] = [];

  async put(m: Memory) {
    this.memories.set(m.id, structuredClone(m));
  }

  async get(id: string) {
    const m = this.memories.get(id);
    return m ? structuredClone(m) : undefined;
  }

  async list(f: MemoryFilter) {
    const rows = [...this.memories.values()].filter((m) => matches(m, f)).sort((a, b) => b.updatedAt - a.updatedAt);
    return (f.limit ? rows.slice(0, f.limit) : rows).map((m) => structuredClone(m));
  }

  async hardDelete(id: string) {
    this.memories.delete(id);
    for (const space of this.vectors.values()) space.delete(id);
    for (let i = this.sourceRows.length - 1; i >= 0; i--) if (this.sourceRows[i]!.memoryId === id) this.sourceRows.splice(i, 1);
    for (let i = this.linkRows.length - 1; i >= 0; i--) if (this.linkRows[i]!.fromId === id || this.linkRows[i]!.toId === id) this.linkRows.splice(i, 1);
  }

  async appendEvent(e: MemoryEvent) {
    this.eventsById.set(e.id, structuredClone(e));
    const list = this.eventsByMemory.get(e.memoryId) ?? [];
    list.push(e.id);
    this.eventsByMemory.set(e.memoryId, list);
  }

  async events(memoryId: string) {
    return (this.eventsByMemory.get(memoryId) ?? []).map((id) => structuredClone(this.eventsById.get(id)!));
  }

  async getEvent(id: string) {
    const e = this.eventsById.get(id);
    return e ? structuredClone(e) : undefined;
  }

  async tombstoneEvents(memoryId: string) {
    for (const id of this.eventsByMemory.get(memoryId) ?? []) {
      const e = this.eventsById.get(id)!;
      delete e.before;
      delete e.after;
      e.reason = e.type === 'deleted' ? e.reason : '[content removed after deletion]';
    }
  }

  async addSource(s: MemorySourceRef) {
    this.sourceRows.push({ ...s });
  }

  async sources(memoryId: string) {
    return this.sourceRows.filter((s) => s.memoryId === memoryId).map((s) => ({ ...s }));
  }

  async addLink(l: MemoryLink) {
    if (!this.linkRows.some((x) => x.fromId === l.fromId && x.toId === l.toId && x.type === l.type)) this.linkRows.push({ ...l });
  }

  async links(memoryId: string) {
    return this.linkRows.filter((l) => l.fromId === memoryId || l.toId === memoryId).map((l) => ({ ...l }));
  }

  async putEmbedding(memoryId: string, spaceId: string, vector: number[]) {
    const space = this.vectors.get(spaceId) ?? new Map();
    space.set(memoryId, [...vector]);
    this.vectors.set(spaceId, space);
  }

  async getEmbedding(memoryId: string, spaceId: string) {
    const v = this.vectors.get(spaceId)?.get(memoryId);
    return v ? [...v] : undefined;
  }

  async vectorSearch(spaceId: string, query: number[], k: number, f: MemoryFilter) {
    const space = this.vectors.get(spaceId) ?? new Map<string, number[]>();
    const out: { memory: Memory; similarity: number }[] = [];
    for (const [id, v] of space) {
      const m = this.memories.get(id);
      if (m && matches(m, f)) out.push({ memory: structuredClone(m), similarity: cosine(query, v) });
    }
    return out.sort((a, b) => b.similarity - a.similarity).slice(0, k);
  }

  async textSearch(query: string, k: number, f: MemoryFilter) {
    const q = new Set(terms(query));
    if (q.size === 0) return [];
    const docs = [...this.memories.values()].filter((m) => matches(m, f));
    const df = new Map<string, number>();
    const docTerms = new Map<string, string[]>();
    for (const m of docs) {
      const t = terms(`${m.title ?? ''} ${m.content}`);
      docTerms.set(m.id, t);
      for (const term of new Set(t)) df.set(term, (df.get(term) ?? 0) + 1);
    }
    const out: { memory: Memory; score: number }[] = [];
    for (const m of docs) {
      const t = docTerms.get(m.id)!;
      let score = 0;
      for (const term of q) {
        const tf = t.filter((x) => x === term).length;
        if (tf > 0) score += (tf / (tf + 1.2)) * Math.log(1 + docs.length / (df.get(term) ?? 1));
      }
      if (score > 0) out.push({ memory: structuredClone(m), score });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, k);
  }

  async putEntity(e: Entity) {
    this.entities.set(e.id, structuredClone(e));
  }

  async getEntity(id: string) {
    const e = this.entities.get(id);
    return e ? structuredClone(e) : undefined;
  }

  async findEntities(text: string) {
    const lower = ` ${text.toLowerCase()} `;
    const words = new Set(terms(text));
    return [...this.entities.values()]
      .filter((e) => [e.name, ...e.aliases].some((n) => {
        const name = n.toLowerCase();
        return lower.includes(` ${name} `) || lower.includes(` ${name}'`) || lower.includes(` ${name}?`) || lower.includes(` ${name}.`) || lower.includes(` ${name},`) || words.has(name);
      }))
      .map((e) => structuredClone(e));
  }

  async listEntities() {
    return [...this.entities.values()].map((e) => structuredClone(e));
  }

  async addSuppression(s: Suppression) {
    this.suppressionRows.push(structuredClone(s));
  }

  async suppressions() {
    return this.suppressionRows.map((s) => structuredClone(s));
  }

  private cores: CoreSnapshot[] = [];
  private notes = '';

  async saveCore(snapshot: CoreSnapshot) {
    this.cores.push(structuredClone(snapshot));
  }

  async latestCore() {
    const c = this.cores.at(-1);
    return c ? structuredClone(c) : undefined;
  }

  async getNotes() {
    return this.notes;
  }

  async setNotes(notes: string) {
    this.notes = notes;
  }
}
