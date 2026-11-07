import type { ProviderAdapter, ProviderEntry } from '../types.ts';
import { AnthropicAdapter } from './anthropic.ts';
import { GoogleAdapter } from './google.ts';
import type { FetchLike } from './http.ts';
import { MockAdapter } from './mock.ts';
import { OpenAiCompatibleAdapter } from './openai-compatible.ts';

export { AnthropicAdapter, toAnthropic } from './anthropic.ts';
export { GoogleAdapter, toGemini, toGeminiSchema } from './google.ts';
export { OpenAiCompatibleAdapter, toOpenAiMessages } from './openai-compatible.ts';
export { parseSse, type FetchLike } from './http.ts';

/** Builds the adapter for one configured provider. The key comes from the vault. */
export function createAdapter(provider: ProviderEntry, apiKey: string | undefined, fetchImpl?: FetchLike): ProviderAdapter {
  const f = fetchImpl ? { fetch: fetchImpl } : {};
  switch (provider.kind) {
    case 'anthropic':
      if (!apiKey) throw new Error(`provider ${provider.id} needs an API key`);
      return new AnthropicAdapter({ apiKey, ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}), ...(provider.headers ? { headers: provider.headers } : {}), ...f });
    case 'google':
      if (!apiKey) throw new Error(`provider ${provider.id} needs an API key`);
      return new GoogleAdapter({ apiKey, ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}), ...f });
    case 'openai':
    case 'openai-compatible':
      return new OpenAiCompatibleAdapter({
        kind: provider.kind,
        ...(apiKey ? { apiKey } : {}),
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
        ...(provider.headers ? { headers: provider.headers } : {}),
        ...f,
      });
    case 'mock':
      return new MockAdapter();
  }
}
