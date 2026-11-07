import type { MemoryStore } from './store.ts';

/**
 * Human-readable JSONL export of everything the owner's memory holds (architecture §7.5).
 * One JSON object per line: memories with their sources and history, then entities.
 */
export async function* exportJsonl(store: MemoryStore): AsyncGenerator<string> {
  yield JSON.stringify({ type: 'header', format: 'feroxes-memory-export', version: 1, exportedAt: new Date().toISOString() });
  for (const m of await store.list({})) {
    yield JSON.stringify({ type: 'memory', memory: m, sources: await store.sources(m.id), links: await store.links(m.id), history: await store.events(m.id) });
  }
  for (const e of await store.listEntities()) yield JSON.stringify({ type: 'entity', entity: e });
  const core = await store.latestCore();
  if (core) yield JSON.stringify({ type: 'core', core });
  const notes = await store.getNotes();
  if (notes) yield JSON.stringify({ type: 'notes', notes });
}
