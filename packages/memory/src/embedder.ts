import type { ModelRouter } from '@feroxes/llm';
import type { PriorityClass } from '@feroxes/shared';
import type { Embedder } from './service.ts';

/** Embedder backed by the router, so embeddings are metered and budgeted like every other call. */
export function routerEmbedder(router: ModelRouter, modelId: string): Embedder {
  return {
    spaceId: modelId,
    async embed(texts: string[], priority: PriorityClass) {
      const result = await router.embed({ texts, priority, modelId, attribution: { taskType: 'memory.embed' } });
      return result.vectors;
    },
  };
}
