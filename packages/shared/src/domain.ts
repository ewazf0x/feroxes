/**
 * Vocabulary shared by every domain package. Kept here (not in llm or metering) because
 * metering, policy, memory and the agent all need it, and they must not import each other.
 */

/** Who is waiting on the work, highest first. See architecture §8.1. */
export const PRIORITY_CLASSES = ['interactive', 'important', 'routine', 'deferrable'] as const;
export type PriorityClass = (typeof PRIORITY_CLASSES)[number];

export const isBackground = (p: PriorityClass): boolean => p !== 'interactive';

export const TIERS = ['local', 'fast', 'balanced', 'frontier'] as const;
export type Tier = (typeof TIERS)[number];

/** Cost order; `local` is cheapest. */
export const tierRank = (t: Tier): number => TIERS.indexOf(t);

export function nextTierUp(t: Tier): Tier | undefined {
  const i = tierRank(t);
  return i >= 0 && i < TIERS.length - 1 ? TIERS[i + 1] : undefined;
}

/** Data sensitivity labels. A provider may only receive data up to its max_sensitivity. */
export const SENSITIVITIES = ['normal', 'private', 'secret'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export const sensitivityRank = (s: Sensitivity): number => SENSITIVITIES.indexOf(s);

export function maxSensitivity(values: Iterable<Sensitivity>): Sensitivity {
  let best: Sensitivity = 'normal';
  for (const v of values) if (sensitivityRank(v) > sensitivityRank(best)) best = v;
  return best;
}

export type PowerMode = 'normal' | 'economy' | 'background_paused';
export type SystemState = 'running' | 'stopped';
