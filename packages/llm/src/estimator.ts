import { type NanoUsd } from '@feroxes/shared';
import { type ModelPrice, computeCost } from '@feroxes/metering';
import type { LlmMessage, ModelEntry, ToolSpec } from './types.ts';

/** Counts tokens for a model. The default is a calibrated heuristic; a real tokenizer can plug in. */
export interface Tokenizer {
  count(model: ModelEntry, text: string): number;
}

export function messageChars(messages: LlmMessage[], tools: ToolSpec[] = []): { chars: number; images: number } {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    chars += 4; // role and framing overhead
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text') chars += part.text.length;
        else images++;
      }
    } else if (m.role === 'assistant') {
      chars += m.content.length;
      for (const c of m.toolCalls ?? []) chars += c.name.length + JSON.stringify(c.args ?? {}).length;
    } else {
      chars += (m as { content: string }).content.length;
    }
  }
  for (const t of tools) chars += t.name.length + t.description.length + JSON.stringify(t.parameters).length;
  return { chars, images };
}

/**
 * Pre-call estimates for budget reservations (Phase 1 plan §7.3).
 * Input: characters ÷ a per-model chars-per-token ratio, calibrated after every call (EMA).
 * Output: p95 of recent outputs on the same route and model.
 */
export class CostEstimator {
  private readonly ratios = new Map<string, number>();
  private readonly outputs = new Map<string, number[]>();
  private readonly alpha: number;
  private readonly defaultRatio: number;
  private readonly imageTokens: number;
  private readonly window: number;

  constructor(options: { alpha?: number; defaultRatio?: number; imageTokens?: number; window?: number } = {}) {
    this.alpha = options.alpha ?? 0.1;
    this.defaultRatio = options.defaultRatio ?? 3.5;
    this.imageTokens = options.imageTokens ?? 1600;
    this.window = options.window ?? 200;
  }

  ratio(modelId: string): number {
    return this.ratios.get(modelId) ?? this.defaultRatio;
  }

  estimateInputTokens(model: ModelEntry, messages: LlmMessage[], tools?: ToolSpec[]): number {
    const { chars, images } = messageChars(messages, tools);
    return Math.ceil(chars / this.ratio(model.id)) + images * this.imageTokens;
  }

  estimateOutputTokens(model: ModelEntry, route: string, maxOutputTokens: number): number {
    const history = this.outputs.get(`${route}|${model.id}`);
    if (!history || history.length < 5) return Math.min(maxOutputTokens, 1024);
    const sorted = [...history].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
    return Math.min(maxOutputTokens, Math.max(16, p95));
  }

  estimateCost(price: ModelPrice | undefined, inputTokens: number, outputTokens: number): NanoUsd {
    if (!price) return 0;
    return computeCost(price, { inputTokens, outputTokens }).total;
  }

  /** Learns from a finished call. `chars` is what the estimate was based on. */
  calibrate(model: ModelEntry, route: string, chars: number, images: number, actualInputTokens: number, actualOutputTokens: number): void {
    const textTokens = actualInputTokens - images * this.imageTokens;
    if (chars > 200 && textTokens > 0) {
      const observed = chars / textTokens;
      if (observed > 0.5 && observed < 12) {
        const current = this.ratio(model.id);
        this.ratios.set(model.id, current + this.alpha * (observed - current));
      }
    }
    const key = `${route}|${model.id}`;
    const list = this.outputs.get(key) ?? [];
    list.push(actualOutputTokens);
    if (list.length > this.window) list.shift();
    this.outputs.set(key, list);
  }
}
