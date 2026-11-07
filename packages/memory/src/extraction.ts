import type { LlmMessage, ModelRouter } from '@feroxes/llm';
import { type Clock, type PriorityClass, type Sensitivity, errorMessage, systemClock } from '@feroxes/shared';
import * as z from 'zod/v4';
import { parseJsonObject } from './json.ts';
import { containsSecret } from './secrets.ts';
import { cosine } from './scoring.ts';
import { type MemoryService, SuppressedError } from './service.ts';
import { LAYER_OF, type Memory } from './types.ts';

export const EXTRACT_PROMPT_VERSION = 'extract-v1';
export const RECONCILE_PROMPT_VERSION = 'reconcile-v1';

const KINDS = ['fact', 'preference', 'relationship', 'goal', 'commitment', 'event', 'rule', 'procedure', 'style'] as const;
const ENTITY_KINDS = ['person', 'org', 'project', 'place', 'account', 'topic', 'thing'] as const;

export const CandidateSchema = z.object({
  kind: z.enum(KINDS),
  content: z.string().min(3).max(600),
  entities: z.array(z.object({ name: z.string().min(1).max(100), kind: z.enum(ENTITY_KINDS).optional() })).max(8).default([]),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  owner_asserted: z.boolean(),
  sensitivity: z.enum(['normal', 'private', 'secret']).default('normal'),
  occurred_at: z.string().max(40).optional(),
  evidence_message_ids: z.array(z.string()).max(20).default([]),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const ExtractionSchema = z.object({ candidates: z.array(CandidateSchema).max(25) });

export const DecisionSchema = z.object({
  action: z.enum(['add', 'update', 'supersede', 'noop']),
  target_id: z.string().optional(),
  merged_content: z.string().max(600).optional(),
  reason: z.string().max(400),
});
export type Decision = z.infer<typeof DecisionSchema>;

const EXTRACT_SYSTEM = `You maintain the long-term memory of Feroxes, a personal assistant for one person ("the owner").
Read the conversation and return durable memories about the owner as JSON.

Extract only information that will still matter later:
- facts, preferences, relationships, goals, commitments with dates, notable events,
- standing instructions ("always…", "never…", "from now on…") as kind "rule",
- how-tos the owner teaches as kind "procedure", and communication-style notes as kind "style".

Rules:
- One atomic statement per memory, in third person ("The owner's sister is named Leila."). Resolve pronouns.
- owner_asserted = true only when the owner stated it directly; false when you inferred it.
- When the owner corrects something ("actually…", "no, it's…"), output the corrected fact with owner_asserted = true.
- Never output the assistant's own claims unless the owner confirmed them.
- Never output passwords, keys, card numbers or other credentials.
- importance: 0.9+ health, money, deadlines, close relationships, explicit "remember"; 0.5 everyday preferences; 0.2 trivia.
- sensitivity: "private" for health, finances, relationships and anything personal; "secret" only for things the owner marks as secret; otherwise "normal".
- entities: people, organisations, projects, places mentioned (not the owner).
- evidence_message_ids: the [msg:…] ids the memory comes from.
- If there is nothing durable, return {"candidates": []}.`;

const RECONCILE_SYSTEM = `You keep a personal memory store consistent. You get one NEW candidate memory and EXISTING memories that look similar.
Choose exactly one action:
- "noop": the candidate says nothing new (same fact, maybe different wording). target_id = the matching memory.
- "update": same subject and the candidate adds detail or refines it without contradicting. target_id + merged_content (one statement combining both).
- "supersede": the candidate contradicts an existing memory and replaces it (the fact changed, or the owner corrected it). target_id = the replaced memory.
- "add": genuinely new information.
Return JSON: {"action": …, "target_id"?: …, "merged_content"?: …, "reason": …}.`;

export interface ExtractionReport {
  candidates: number;
  added: string[];
  updated: string[];
  superseded: { oldId: string; newId: string }[];
  evidence: string[];
  flagged: string[];
  dropped: { content: string; reason: string }[];
  costNanoUsd: number;
}

export interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

/**
 * Write path, steps 2–4 (architecture §7.2): extract candidates with the fast tier, then
 * reconcile each against similar memories. Fixed rules override the model where it matters.
 */
export class ExtractionService {
  private readonly router: ModelRouter;
  private readonly memory: MemoryService;
  private readonly clock: Clock;

  constructor(deps: { router: ModelRouter; memory: MemoryService; clock?: Clock }) {
    this.router = deps.router;
    this.memory = deps.memory;
    this.clock = deps.clock ?? systemClock;
  }

  async process(input: { sessionId: string; messages: TranscriptMessage[]; sensitivity?: Sensitivity; priority?: PriorityClass; runId?: string; signal?: AbortSignal }): Promise<ExtractionReport> {
    const report: ExtractionReport = { candidates: 0, added: [], updated: [], superseded: [], evidence: [], flagged: [], dropped: [], costNanoUsd: 0 };
    const transcript = input.messages
      .filter((m) => m.content.trim())
      .map((m) => `[msg:${m.id}] ${m.role === 'user' ? 'owner' : 'feroxes'} (${new Date(m.createdAt).toISOString().slice(0, 16)}): ${m.content}`)
      .join('\n');
    if (!transcript) return report;

    const priority = input.priority ?? 'routine';
    const messages: LlmMessage[] = [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: `Today is ${new Date(this.clock.now()).toISOString().slice(0, 10)}.\n\nConversation:\n${transcript}` },
    ];
    const extraction = await this.structured(ExtractionSchema, {
      route: 'memory.extract',
      priority,
      messages,
      output: { name: 'memory_candidates', schema: z.toJSONSchema(ExtractionSchema) as Record<string, unknown> },
      sensitivity: input.sensitivity ?? 'private',
      attribution: { taskType: 'memory.extract', promptVersion: EXTRACT_PROMPT_VERSION, sessionId: input.sessionId, ...(input.runId ? { runId: input.runId } : {}) },
      ...(input.signal ? { signal: input.signal } : {}),
    }, report);
    if (!extraction) return report;

    const known = new Set(input.messages.map((m) => m.id));
    report.candidates = extraction.candidates.length;
    for (const c of extraction.candidates) {
      if (containsSecret(c.content)) {
        report.dropped.push({ content: '[redacted]', reason: 'looks like a credential' });
        continue;
      }
      try {
        await this.reconcile(c, { sessionId: input.sessionId, priority, known, report, ...(input.runId ? { runId: input.runId } : {}), sensitivity: input.sensitivity ?? 'private' });
      } catch (error) {
        if (error instanceof SuppressedError) report.dropped.push({ content: c.content, reason: 'owner asked to forget this' });
        else report.dropped.push({ content: c.content, reason: errorMessage(error) });
      }
    }
    return report;
  }

  private async reconcile(c: Candidate, ctx: { sessionId: string; priority: PriorityClass; known: Set<string>; report: ExtractionReport; runId?: string; sensitivity: Sensitivity }) {
    const { report } = ctx;
    const sources = c.evidence_message_ids.filter((id) => ctx.known.has(id)).map((id) => ({ sourceType: 'message' as const, sourceId: id }));
    const occurredAt = c.occurred_at ? Date.parse(c.occurred_at) : undefined;
    const input = {
      content: c.content,
      kind: c.kind,
      importance: c.importance,
      confidence: c.owner_asserted ? Math.max(c.confidence, 0.9) : Math.min(c.confidence, 0.85),
      sensitivity: c.sensitivity,
      source: c.owner_asserted ? ('owner_asserted' as const) : ('extracted' as const),
      entities: c.entities,
      sources: [...sources, { sourceType: 'session' as const, sourceId: ctx.sessionId }],
      ...(occurredAt !== undefined && Number.isFinite(occurredAt) ? { occurredAt } : c.kind === 'event' ? { occurredAt: this.clock.now() } : {}),
      // Inferred, low-confidence memories are kept but hidden until more evidence arrives.
      ...(!c.owner_asserted && c.confidence < 0.4 ? { status: 'archived' as const, structured: { lowConfidence: true } } : {}),
    };

    if (await this.memory.isSuppressed(c.content, await this.memory.embedOne(c.content, ctx.priority))) {
      report.dropped.push({ content: c.content, reason: 'owner asked to forget this' });
      return;
    }

    const neighbors = await this.neighbors(c, ctx.priority);
    if (neighbors.length === 0) {
      const m = await this.memory.remember(input, 'extractor', { reason: 'new information', ...(ctx.runId ? { runId: ctx.runId } : {}), priority: ctx.priority });
      report.added.push(m.id);
      return;
    }

    // Exact duplicate: no model call needed.
    const exact = neighbors.find((n) => n.similarity >= 0.985 || n.memory.content.toLowerCase() === c.content.toLowerCase());
    let decision: Decision | undefined = exact ? { action: 'noop', target_id: exact.memory.id, reason: 'same statement' } : undefined;
    if (!decision) {
      const list = neighbors.map((n) => `- id=${n.memory.id} (${n.memory.kind}, ${n.memory.source === 'owner_asserted' ? 'stated by owner' : 'inferred'}): ${n.memory.content}`).join('\n');
      decision = await this.structured(DecisionSchema, {
        route: 'memory.reconcile',
        priority: ctx.priority,
        messages: [
          { role: 'system', content: RECONCILE_SYSTEM },
          { role: 'user', content: `NEW (${c.owner_asserted ? 'stated by owner' : 'inferred'}, ${c.kind}): ${c.content}\n\nEXISTING:\n${list}` },
        ],
        output: { name: 'memory_decision', schema: z.toJSONSchema(DecisionSchema) as Record<string, unknown> },
        sensitivity: ctx.sensitivity,
        attribution: { taskType: 'memory.reconcile', promptVersion: RECONCILE_PROMPT_VERSION, sessionId: ctx.sessionId },
      }, report);
      decision ??= { action: 'add', reason: 'reconciliation failed; keeping the candidate' };
    }

    const target = decision.target_id ? neighbors.find((n) => n.memory.id === decision.target_id)?.memory : undefined;
    let action = decision.action;
    if (action !== 'add' && !target) action = 'add';

    // Fixed rule: an inferred candidate never overrides something the owner stated.
    if (target && target.source === 'owner_asserted' && !c.owner_asserted && (action === 'update' || action === 'supersede')) {
      const m = await this.memory.remember({ ...input, confidence: Math.min(input.confidence, 0.35), status: 'archived', structured: { needsReview: true, contradicts: target.id } }, 'extractor', { reason: `inferred; conflicts with owner-stated memory ${target.id}` });
      await this.memory.store.addLink({ fromId: m.id, toId: target.id, type: 'contradicts' });
      report.flagged.push(m.id);
      return;
    }
    // Fixed rule: an owner correction that conflicts always supersedes, even if the model said "update".
    if (target && c.owner_asserted && action === 'update' && decision.merged_content === undefined) action = 'supersede';

    switch (action) {
      case 'noop': {
        const firstSource = sources[0];
        await this.memory.addEvidence(target!.id, 'extractor', decision.reason, firstSource);
        report.evidence.push(target!.id);
        return;
      }
      case 'update': {
        await this.memory.update(target!.id, { content: decision.merged_content ?? c.content, importance: Math.max(target!.importance, c.importance) }, 'extractor', decision.reason);
        for (const s of sources) await this.memory.store.addSource({ ...s, memoryId: target!.id });
        report.updated.push(target!.id);
        return;
      }
      case 'supersede': {
        const m = await this.memory.supersede(target!.id, input, 'extractor', decision.reason);
        report.superseded.push({ oldId: target!.id, newId: m.id });
        return;
      }
      case 'add': {
        const m = await this.memory.remember(input, 'extractor', { reason: decision.reason, priority: ctx.priority });
        report.added.push(m.id);
      }
    }
  }

  private async neighbors(c: Candidate, priority: PriorityClass): Promise<{ memory: Memory; similarity: number }[]> {
    const results = await this.memory.search({ text: c.content, limit: 8, priority });
    const vector = await this.memory.embedOne(c.content, priority);
    const out: { memory: Memory; similarity: number }[] = [];
    const entityNames = c.entities.map((e) => e.name.toLowerCase());
    for (const r of results) {
      if (r.memory.layer !== LAYER_OF[c.kind]) continue;
      const v = vector ? await this.memory.embeddingOf(r.memory.id) : undefined;
      const similarity = vector && v ? cosine(vector, v) : 0;
      let sharesEntity = false;
      for (const id of r.memory.entityIds) {
        const e = await this.memory.store.getEntity(id);
        if (e && [e.name, ...e.aliases].some((n) => entityNames.includes(n.toLowerCase()))) sharesEntity = true;
      }
      if (similarity >= 0.75 || (sharesEntity && similarity >= 0.35)) out.push({ memory: r.memory, similarity });
    }
    return out.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
  }

  /** Calls the router for JSON output, validates it, and retries once with the validation error. */
  private async structured<T extends z.ZodType>(schema: T, req: Parameters<ModelRouter['generate']>[0], report: ExtractionReport): Promise<z.infer<T> | undefined> {
    let messages = req.messages;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.router.generate({ ...req, messages });
      report.costNanoUsd += result.finish.costNanoUsd;
      try {
        const parsed = schema.safeParse(parseJsonObject(result.text));
        if (parsed.success) return parsed.data;
        messages = [...req.messages, { role: 'assistant', content: result.text }, { role: 'user', content: `That JSON did not match the schema: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}. Reply with corrected JSON only.` }];
      } catch (error) {
        messages = [...req.messages, { role: 'assistant', content: result.text }, { role: 'user', content: `That was not valid JSON (${errorMessage(error)}). Reply with JSON only.` }];
      }
    }
    return undefined;
  }
}
