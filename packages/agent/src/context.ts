import type { ContentPart, LlmMessage, ModelRouter } from '@feroxes/llm';
import type { MemoryService } from '@feroxes/memory';
import { type Clock, type Sensitivity, systemClock } from '@feroxes/shared';
import { coreMemoryPrompt, systemPrompt } from './prompts.ts';
import type { AgentStore, Session, SessionMessage } from './store.ts';

export interface BuiltContext {
  messages: LlmMessage[];
  cacheBreakpoints: number[];
  memoryIds: string[];
  /** The memory block attached to the newest user message (stored with that message). */
  renderedContext?: string;
  tokens: number;
}

export interface ContextBudgets {
  inputTarget: number; // whole prompt
  core: number;
  retrieved: number;
  keepVerbatimTurns: number;
}

export const DEFAULT_BUDGETS: ContextBudgets = { inputTarget: 16_000, core: 1_200, retrieved: 2_500, keepVerbatimTurns: 6 };

const tokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Builds prompts in the six-layer, cache-friendly order (architecture §7.6):
 * [1] static system  [2] core memory  [3] session summary  [4] earlier turns  [5] latest turn + memories.
 * Earlier user turns are replayed with the exact memory block they were sent with.
 */
export class ContextBuilder {
  private readonly memory: MemoryService;
  private readonly store: AgentStore;
  private readonly router: ModelRouter;
  private readonly clock: Clock;
  private readonly timeZone: string;
  private readonly assistantName: string;
  private readonly ownerName: string | undefined;

  constructor(deps: { memory: MemoryService; store: AgentStore; router: ModelRouter; clock?: Clock; timeZone: string; assistantName?: string; ownerName?: string }) {
    this.memory = deps.memory;
    this.store = deps.store;
    this.router = deps.router;
    this.clock = deps.clock ?? systemClock;
    this.timeZone = deps.timeZone;
    this.assistantName = deps.assistantName ?? 'Feroxes';
    this.ownerName = deps.ownerName;
  }

  async build(input: { session: Session; maxSensitivity: Sensitivity; budgets?: Partial<ContextBudgets>; retrieveFor?: SessionMessage; signal?: AbortSignal }): Promise<BuiltContext> {
    const b = { ...DEFAULT_BUDGETS, ...input.budgets };
    let session = input.session;
    let history = await this.store.messages(session.id, { afterSeq: session.summaryThroughSeq });

    // Compaction: fold the oldest turns into the rolling summary once history outgrows its share.
    const historyBudget = b.inputTarget - b.core - b.retrieved - 3_000;
    if (sumTokens(history) > historyBudget) {
      session = await this.compact(session, history, b.keepVerbatimTurns, input.signal);
      history = await this.store.messages(session.id, { afterSeq: session.summaryThroughSeq });
    }

    const core = await this.memory.coreBlock(input.maxSensitivity, b.core);
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt({ assistantName: this.assistantName, ...(this.ownerName ? { ownerName: this.ownerName } : {}) }) },
      { role: 'system', content: coreMemoryPrompt(core.text, this.timeZone, new Date(this.clock.now())) },
    ];
    const breakpoints = [0, 1];
    if (session.rollingSummary) messages.push({ role: 'system', content: `Earlier in this conversation:\n${session.rollingSummary}` });

    // Retrieval for the newest user message (or the given one, when resuming).
    const latestUser = input.retrieveFor ?? [...history].reverse().find((m) => m.role === 'user');
    let rendered: string | undefined;
    let memoryIds: string[] = [];
    if (latestUser && latestUser.renderedContext === undefined) {
      const ctx = await this.memory.buildContext({ query: latestUser.content, maxSensitivity: input.maxSensitivity, budgets: { core: b.core, retrieved: b.retrieved }, excludeIds: core.ids });
      rendered = ctx.rendered;
      memoryIds = ctx.usedIds;
    } else if (latestUser) {
      rendered = latestUser.renderedContext;
      memoryIds = latestUser.meta?.memoryIds ?? [];
    }

    // Screenshots are expensive: only the two most recent are sent as images. They follow the
    // whole group of tool results, because providers require tool results right after the call.
    const imageIds = new Set(history.filter((m) => m.role === 'tool' && m.images?.length).slice(-2).map((m) => m.id));
    let pendingImages: ContentPart[] = [];
    const flushImages = () => {
      if (pendingImages.length) messages.push({ role: 'user', content: pendingImages });
      pendingImages = [];
    };

    for (const m of history) {
      if (m.role !== 'tool') flushImages();
      if (m.role === 'tool' && m.images?.length) {
        const keep = imageIds.has(m.id);
        messages.push({ role: 'tool', toolCallId: m.toolCallId!, toolName: m.toolName!, content: keep ? m.content : `${m.content}\n[older screenshot omitted to save tokens]`, ...(m.isError ? { isError: true } : {}) });
        if (keep) pendingImages.push({ type: 'text', text: `Image returned by ${m.toolName}:` }, ...m.images.map((i): ContentPart => ({ type: 'image', mediaType: i.mediaType, dataBase64: i.dataBase64 })));
        continue;
      }
      if (m.role === 'user') {
        const block = m.id === latestUser?.id ? rendered : m.renderedContext;
        messages.push({ role: 'user', content: block ? `${m.content}\n\n${block}` : m.content });
      } else if (m.role === 'assistant') {
        messages.push({ role: 'assistant', content: m.content, ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}), ...(m.providerState ? { providerState: m.providerState } : {}) });
      } else if (m.role === 'tool') {
        messages.push({ role: 'tool', toolCallId: m.toolCallId!, toolName: m.toolName!, content: m.content, ...(m.isError ? { isError: true } : {}) });
      }
    }
    flushImages();
    // The last earlier turn is a third breakpoint, so the next request reuses the whole prefix.
    if (messages.length > 3) breakpoints.push(messages.length - 2);

    return { messages, cacheBreakpoints: breakpoints, memoryIds, ...(rendered !== undefined ? { renderedContext: rendered } : {}), tokens: messages.reduce((n, m) => n + tokens(typeof m.content === 'string' ? m.content : ''), 0) };
  }

  private async compact(session: Session, history: SessionMessage[], keep: number, signal?: AbortSignal): Promise<Session> {
    // Keep the last `keep` user turns (and everything after the first of them) verbatim.
    const userIdx = history.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
    const cut = userIdx.length > keep ? userIdx[userIdx.length - keep]! : 0;
    if (cut === 0) return session;
    const fold = history.slice(0, cut);
    const transcript = fold
      .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
      .map((m) => `${m.role === 'user' ? 'Owner' : 'Feroxes'}: ${m.content}`)
      .join('\n');
    const result = await this.router.generate({
      route: 'session.summarize',
      priority: 'interactive',
      messages: [
        { role: 'system', content: 'Update the running summary of this conversation. Keep names, decisions, numbers, open questions and promises. 120–250 words, third person.' },
        { role: 'user', content: `${session.rollingSummary ? `Summary so far:\n${session.rollingSummary}\n\n` : ''}New part of the conversation:\n${transcript}` },
      ],
      sensitivity: 'private',
      attribution: { taskType: 'session.compact', sessionId: session.id },
      ...(signal ? { signal } : {}),
    });
    const updated: Session = { ...session, rollingSummary: result.text.trim(), summaryThroughSeq: fold.at(-1)!.seq };
    await this.store.updateSession(updated);
    return updated;
  }
}

function sumTokens(messages: SessionMessage[]): number {
  return messages.reduce((n, m) => n + tokens(m.content) + tokens(m.renderedContext ?? '') + (m.toolCalls ? tokens(JSON.stringify(m.toolCalls)) : 0), 0);
}
