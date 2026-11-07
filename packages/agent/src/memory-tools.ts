import type { MemoryService } from '@feroxes/memory';
import { type AnyTool, defineTool, z } from '@feroxes/tools';

const KINDS = ['fact', 'preference', 'relationship', 'goal', 'commitment', 'event', 'rule', 'procedure', 'style'] as const;

/** Tools that let the agent manage memory deliberately (architecture §7.4). */
export function memoryTools(memory: MemoryService): AnyTool[] {
  const search = defineTool({
    name: 'memory.search',
    toolset: 'memory',
    description: "Search the owner's long-term memory (facts, preferences, past conversations, rules). Use it when the provided memories don't cover what you need.",
    input: z.object({ query: z.string().min(2).max(300), historical: z.boolean().default(false).describe('Include facts that were later corrected or expired.') }),
    risk: { category: 'read', reversible: true },
    idempotent: true,
    async execute({ query, historical }) {
      const hits = await memory.search({ text: query, limit: 8, historical });
      if (hits.length === 0) return { content: 'No matching memories.' };
      return {
        content: hits.map((h) => `[m:${h.memory.id.slice(-8)}] (${h.memory.kind}${h.memory.status !== 'active' ? `, ${h.memory.status}` : ''}) ${h.memory.content}`).join('\n'),
        data: { ids: hits.map((h) => h.memory.id) },
      };
    },
  });

  const save = defineTool({
    name: 'memory.save',
    toolset: 'memory',
    description: 'Save something the owner explicitly asked you to remember, or a standing instruction they gave. One clear statement in third person.',
    input: z.object({
      content: z.string().min(3).max(600),
      kind: z.enum(KINDS),
      importance: z.number().min(0).max(1).default(0.7),
      sensitivity: z.enum(['normal', 'private', 'secret']).default('normal'),
      people: z.array(z.string().max(80)).max(5).default([]),
    }),
    risk: { category: 'internal_write', reversible: true },
    idempotent: false,
    async execute(input, ctx) {
      // The owner asked for this in the conversation, so it counts as owner-stated.
      const m = await memory.remember(
        { content: input.content, kind: input.kind, importance: input.importance, sensitivity: input.sensitivity, source: 'owner_asserted', entities: input.people.map((name) => ({ name, kind: 'person' as const })), sources: [{ sourceType: 'run', sourceId: ctx.runId }] },
        'agent',
        { runId: ctx.runId, reason: 'saved at the owner\'s request', priority: 'interactive' },
      );
      return { content: `Saved [m:${m.id.slice(-8)}]: ${m.content}`, data: { id: m.id } };
    },
  });

  const update = defineTool({
    name: 'memory.update',
    toolset: 'memory',
    description: 'Correct an existing memory when the owner tells you it is wrong or outdated. Use the id from [m:…] (the last 8 characters are enough).',
    input: z.object({ id: z.string().min(8).max(40), content: z.string().min(3).max(600), reason: z.string().max(200) }),
    risk: { category: 'internal_write', reversible: true },
    idempotent: false,
    async execute({ id, content, reason }, ctx) {
      const target = await resolveId(memory, id);
      if (!target) return { content: `No memory with id ${id}.`, isError: true };
      const m = await memory.supersede(target, { content, kind: (await memory.store.get(target))!.kind, source: 'owner_asserted' }, 'agent', reason, ctx.runId);
      return { content: `Updated. New version [m:${m.id.slice(-8)}]: ${m.content}` };
    },
  });

  const forget = defineTool({
    name: 'memory.forget',
    toolset: 'memory',
    description: 'Hide a memory from future use (archive it) when the owner asks you to forget it. Permanent deletion is only possible in the memory browser.',
    input: z.object({ id: z.string().min(8).max(40), reason: z.string().max(200) }),
    risk: { category: 'destructive', reversible: true },
    idempotent: false,
    preview: ({ id, reason }) => ({ title: `Forget memory ${id}`, body: reason }),
    async execute({ id, reason }) {
      const target = await resolveId(memory, id);
      if (!target) return { content: `No memory with id ${id}.`, isError: true };
      await memory.archive(target, 'agent', reason);
      return { content: 'Archived. It will no longer be used.' };
    },
  });

  return [search, save, update, forget] as unknown as AnyTool[];
}

async function resolveId(memory: MemoryService, id: string): Promise<string | undefined> {
  if (await memory.store.get(id)) return id;
  const suffix = id.replace(/^m:/, '').toLowerCase();
  const all = await memory.store.list({});
  const matches = all.filter((m) => m.id.toLowerCase().endsWith(suffix));
  return matches.length === 1 ? matches[0]!.id : undefined;
}
