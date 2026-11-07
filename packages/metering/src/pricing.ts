import { type NanoUsd, costPerMillion } from '@feroxes/shared';

/**
 * A price row is valid for [effectiveFrom, effectiveTo). Rows are never edited in place:
 * a price change adds a new row, so historical costs never change.
 */
export interface ModelPrice {
  id: string;
  modelId: string;
  effectiveFrom: number;
  effectiveTo?: number;
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok?: number; // defaults to inputPerMTok when the provider has no discount
  cacheWritePerMTok?: number; // defaults to inputPerMTok
  /** Higher rates once the prompt passes a context-length threshold (e.g. > 200k tokens). */
  contextTiers?: { aboveInputTokens: number; inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number }[];
  /** Price per unit for non-token usage (TTS characters, STT seconds, search calls). */
  unitPrice?: number;
  batchDiscount?: number; // 0.5 = half price for batch API calls
  sourceUrl?: string;
}

export interface TokenUsage {
  inputTokens: number; // total prompt tokens, including cached and cache-write
  outputTokens: number; // includes reasoning tokens
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  units?: number;
  batch?: boolean;
}

export interface CostBreakdown {
  total: NanoUsd;
  input: NanoUsd;
  cachedInput: NanoUsd;
  cacheWrite: NanoUsd;
  output: NanoUsd;
  units: NanoUsd;
}

export function computeCost(price: ModelPrice, usage: TokenUsage): CostBreakdown {
  const tier = [...(price.contextTiers ?? [])]
    .sort((a, b) => b.aboveInputTokens - a.aboveInputTokens)
    .find((t) => usage.inputTokens > t.aboveInputTokens);

  const inputRate = tier?.inputPerMTok ?? price.inputPerMTok;
  const outputRate = tier?.outputPerMTok ?? price.outputPerMTok;
  const cachedRate = tier?.cachedInputPerMTok ?? price.cachedInputPerMTok ?? inputRate;
  const writeRate = price.cacheWritePerMTok ?? inputRate;

  const cached = Math.max(0, usage.cachedInputTokens ?? 0);
  const written = Math.max(0, usage.cacheWriteTokens ?? 0);
  const fresh = Math.max(0, usage.inputTokens - cached - written);

  const parts = {
    input: costPerMillion(fresh, inputRate),
    cachedInput: costPerMillion(cached, cachedRate),
    cacheWrite: costPerMillion(written, writeRate),
    output: costPerMillion(Math.max(0, usage.outputTokens), outputRate),
    units: Math.round((usage.units ?? 0) * (price.unitPrice ?? 0) * 1_000_000_000),
  };
  let total = parts.input + parts.cachedInput + parts.cacheWrite + parts.output + parts.units;
  if (usage.batch && price.batchDiscount) total = Math.round(total * (1 - price.batchDiscount));
  return { total, ...parts };
}

export class PriceBook {
  private readonly byModel = new Map<string, ModelPrice[]>();

  constructor(prices: ModelPrice[] = []) {
    for (const p of prices) this.add(p);
  }

  add(price: ModelPrice): void {
    const list = this.byModel.get(price.modelId) ?? [];
    list.push(price);
    list.sort((a, b) => a.effectiveFrom - b.effectiveFrom);
    this.byModel.set(price.modelId, list);
  }

  /** The price valid at `ts`, or undefined (the dashboard flags models without a current price). */
  priceAt(modelId: string, ts: number): ModelPrice | undefined {
    const list = this.byModel.get(modelId) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i]!;
      if (p.effectiveFrom <= ts && (p.effectiveTo === undefined || ts < p.effectiveTo)) return p;
    }
    return undefined;
  }
}
