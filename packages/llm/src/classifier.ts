import type { Tier } from '@feroxes/shared';
import type { LlmMessage } from './types.ts';

export interface ComplexityDecision {
  tier: Tier;
  score: number;
  uncertain: boolean;
  features: Record<string, number | boolean>;
  override?: 'think_hard' | 'quick';
}

const HARD_WORDS = /\b(plan|planning|compare|comparison|analy[sz]e|analysis|debug|refactor|architect|design|strategy|prove|derive|trade-?offs?|step[- ]by[- ]step|research|investigate|evaluate|optimi[sz]e|write (a|an|the) (report|essay|proposal|spec|plan|program|script))\b/i;
const THINK_HARD = /\b(think (really )?hard|ultrathink|deep(ly)? think|use your best model|be thorough)\b/i;
const QUICK = /\b(quick(ly)?|briefly|tl;?dr|one[- ]liner|short answer)\b/i;

function lastUserText(messages: LlmMessage[]): { text: string; images: number } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return { text: m.content, images: 0 };
    return {
      text: m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n'),
      images: m.content.filter((p) => p.type === 'image').length,
    };
  }
  return { text: '', images: 0 };
}

/**
 * Cheap heuristic for `tier: auto` (Phase 1 plan §7.6). Scores 0..1; the uncertain bands
 * are where a fast-tier classification call may be used instead.
 */
export function classifyComplexity(messages: LlmMessage[], context: { previousTier?: Tier; escalated?: boolean } = {}): ComplexityDecision {
  const { text, images } = lastUserText(messages);
  if (THINK_HARD.test(text)) return { tier: 'frontier', score: 1, uncertain: false, features: {}, override: 'think_hard' };

  const length = text.length;
  const codeBlocks = (text.match(/```/g) ?? []).length / 2;
  const stackTrace = /\n\s+at\s+\S+\s+\(|Traceback \(most recent call last\)|Exception in thread/.test(text);
  const hardWords = (text.match(new RegExp(HARD_WORDS.source, 'gi')) ?? []).length;
  const questions = (text.match(/\?/g) ?? []).length;
  const listItems = (text.match(/^\s*(\d+[.)]|[-*•])\s+/gm) ?? []).length;
  const depth = messages.filter((m) => m.role === 'user').length;

  let score = 0.1;
  score += Math.min(0.3, length / 4000);
  score += Math.min(0.25, codeBlocks * 0.12);
  score += stackTrace ? 0.2 : 0;
  score += Math.min(0.35, hardWords * 0.15);
  score += Math.min(0.1, Math.max(0, questions - 1) * 0.04);
  score += Math.min(0.15, listItems * 0.03);
  score += images > 0 ? 0.1 : 0;
  score += depth > 8 ? 0.05 : 0;
  if (context.previousTier === 'frontier') score += 0.1;
  if (context.escalated) score += 0.35;

  const quick = QUICK.test(text);
  if (quick) score = Math.min(score, 0.3);
  score = Math.max(0, Math.min(1, score));

  const tier: Tier = score > 0.7 ? 'frontier' : score >= 0.35 ? 'balanced' : 'fast';
  const uncertain = (score >= 0.3 && score <= 0.4) || (score >= 0.65 && score <= 0.75);
  const features = { length, codeBlocks, stackTrace, hardWords, questions, listItems, images, depth };
  return quick ? { tier, score, uncertain: false, features, override: 'quick' } : { tier, score, uncertain, features };
}
