import type { Tier } from '@feroxes/shared';
import type { ModelEntry, ProviderEntry, RouteConfig } from './types.ts';

/**
 * Providers, models, tiers and routes. The database is the source of truth in production;
 * this in-memory registry is what the router reads (reloaded when Settings change).
 */
export class Catalog {
  private readonly providers = new Map<string, ProviderEntry>();
  private readonly models = new Map<string, ModelEntry>();
  private readonly routes = new Map<string, RouteConfig>();
  private tierLists: Partial<Record<Tier, string[]>> = {};

  constructor(init: { providers?: ProviderEntry[]; models?: ModelEntry[]; tiers?: Partial<Record<Tier, string[]>>; routes?: RouteConfig[] } = {}) {
    for (const p of init.providers ?? []) this.providers.set(p.id, p);
    for (const m of init.models ?? []) this.models.set(m.id, m);
    for (const r of init.routes ?? []) this.routes.set(r.id, r);
    this.tierLists = { ...(init.tiers ?? {}) };
  }

  provider(id: string): ProviderEntry | undefined {
    return this.providers.get(id);
  }

  model(id: string): ModelEntry | undefined {
    return this.models.get(id);
  }

  route(id: string): RouteConfig | undefined {
    return this.routes.get(id);
  }

  tier(tier: Tier): string[] {
    return this.tierLists[tier] ?? [];
  }

  listModels(): ModelEntry[] {
    return [...this.models.values()];
  }

  listProviders(): ProviderEntry[] {
    return [...this.providers.values()];
  }

  upsertProvider(p: ProviderEntry): void {
    this.providers.set(p.id, p);
  }

  upsertModel(m: ModelEntry): void {
    this.models.set(m.id, m);
  }

  setTier(tier: Tier, modelIds: string[]): void {
    this.tierLists[tier] = [...modelIds];
  }

  upsertRoute(r: RouteConfig): void {
    this.routes.set(r.id, r);
  }

  /** The active embedding model: first enabled embedding model of an enabled provider. */
  embeddingModel(preferredId?: string): ModelEntry | undefined {
    const candidates = this.listModels().filter((m) => m.modality === 'embedding' && m.enabled && this.provider(m.providerId)?.enabled);
    return candidates.find((m) => m.id === preferredId) ?? candidates[0];
  }
}
