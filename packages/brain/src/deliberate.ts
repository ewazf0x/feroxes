import type { ModelRouter } from '@feroxes/llm';
import { errorMessage } from '@feroxes/shared';

export const PERSPECTIVES = {
  strategist: 'You are the Strategist. Which option best serves the owner\'s goals over weeks and months? Name the key trade-off.',
  critic: 'You are the Critic. Find the weakest assumption, what could go wrong, and what is missing. Be specific.',
  safety: "You are the Safety Officer. Check privacy, money, reputation, irreversibility and the owner's stated values. Say what must be confirmed with the owner first.",
  optimizer: 'You are the Optimizer. What is the cheapest, fastest way to get most of the value (time, money, tokens)?',
  creative: 'You are the Creative. Propose one option nobody listed that could be better.',
} as const;
export type Perspective = keyof typeof PERSPECTIVES;

export interface Deliberation {
  question: string;
  views: { perspective: Perspective; text: string }[];
  synthesis: string;
  costNanoUsd: number;
}

/**
 * Internal debate for important decisions: several cheap perspective calls in parallel, then one
 * stronger synthesis that predicts outcomes and checks alignment with the owner's values.
 * Costs a few cents at most; the agent is told to use it only when the stakes justify it.
 */
export async function deliberate(router: ModelRouter, input: { question: string; context?: string; options?: string[]; values: string[]; perspectives?: Perspective[]; runId?: string; signal?: AbortSignal }): Promise<Deliberation> {
  const perspectives = input.perspectives ?? (['strategist', 'critic', 'safety', 'optimizer', 'creative'] as Perspective[]);
  const brief = [`Decision: ${input.question}`, input.options?.length ? `Options:\n${input.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}` : '', input.context ? `Context:\n${input.context.slice(0, 6000)}` : ''].filter(Boolean).join('\n\n');
  let cost = 0;
  const attribution = { taskType: 'think.deliberate', ...(input.runId ? { runId: input.runId } : {}) };

  const views = await Promise.all(
    perspectives.map(async (p) => {
      try {
        const r = await router.generate({ route: 'think.perspective', messages: [{ role: 'system', content: `${PERSPECTIVES[p]} Answer in at most 120 words.` }, { role: 'user', content: brief }], sensitivity: 'private', attribution, ...(input.signal ? { signal: input.signal } : {}) });
        cost += r.finish.costNanoUsd;
        return { perspective: p, text: r.text.trim() };
      } catch (error) {
        return { perspective: p, text: `(unavailable: ${errorMessage(error)})` };
      }
    }),
  );

  const synthesisPrompt = `You chair an internal debate for a personal AI agent. Combine the views into one decision.
Reply with these headings:
Recommendation: one or two sentences.
Predicted outcome: what will most likely happen if we do it, and the main risk.
Alignment: does it fit the owner's values (listed below)? If not, say so.
Ask the owner first: yes or no, and what exactly to ask.
Owner's values:
${input.values.map((v) => `- ${v}`).join('\n')}`;
  const synthesis = await router.generate({
    route: 'think.synthesis',
    messages: [{ role: 'system', content: synthesisPrompt }, { role: 'user', content: `${brief}\n\nViews:\n${views.map((v) => `[${v.perspective}] ${v.text}`).join('\n\n')}` }],
    sensitivity: 'private',
    attribution,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  cost += synthesis.finish.costNanoUsd;
  return { question: input.question, views, synthesis: synthesis.text.trim(), costNanoUsd: cost };
}
