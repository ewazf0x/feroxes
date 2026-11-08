/** Small document store for brain state (self-model versions, goals, skills, reflections…). */
export interface DocStore {
  put<T extends { id: string }>(kind: string, doc: T, updatedAt?: number): void;
  get<T>(kind: string, id: string): T | undefined;
  list<T>(kind: string): T[];
  delete(kind: string, id: string): void;
}

export class InMemoryDocStore implements DocStore {
  private readonly rows = new Map<string, Map<string, { doc: unknown; updatedAt: number }>>();
  put<T extends { id: string }>(kind: string, doc: T, updatedAt = Date.now()) {
    const m = this.rows.get(kind) ?? new Map();
    m.set(doc.id, { doc: structuredClone(doc), updatedAt });
    this.rows.set(kind, m);
  }
  get<T>(kind: string, id: string): T | undefined {
    const r = this.rows.get(kind)?.get(id);
    return r ? (structuredClone(r.doc) as T) : undefined;
  }
  list<T>(kind: string): T[] {
    return [...(this.rows.get(kind)?.values() ?? [])].sort((a, b) => a.updatedAt - b.updatedAt).map((r) => structuredClone(r.doc) as T);
  }
  delete(kind: string, id: string) {
    this.rows.get(kind)?.delete(id);
  }
}
