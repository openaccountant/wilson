import { PROVIDERS as PROVIDER_DEFS } from '../providers.js';

export type ModelTag = 'paid' | 'open' | 'local' | 'cloud' | 'small' | 'large' | 'reasoning';

export interface Model {
  id: string;
  displayName: string;
  tags?: ModelTag[];
}

interface Provider {
  displayName: string;
  providerId: string;
  models: Model[];
}

const PROVIDER_MODELS: Record<string, Model[]> = {
  openai: [
    { id: 'gpt-5.2', displayName: 'GPT 5.2', tags: ['paid', 'cloud', 'large'] },
    { id: 'gpt-4.1', displayName: 'GPT 4.1', tags: ['paid', 'cloud'] },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', tags: ['paid', 'cloud'] },
    { id: 'claude-opus-4-6', displayName: 'Opus 4.6', tags: ['paid', 'cloud', 'large'] },
  ],
  google: [
    { id: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash', tags: ['paid', 'cloud', 'small'] },
    { id: 'gemini-3-pro-preview', displayName: 'Gemini 3 Pro', tags: ['paid', 'cloud'] },
  ],
  xai: [
    { id: 'grok-4-0709', displayName: 'Grok 4', tags: ['paid', 'cloud'] },
    { id: 'grok-4-1-fast-reasoning', displayName: 'Grok 4.1 Fast Reasoning', tags: ['paid', 'cloud', 'reasoning'] },
  ],
  moonshot: [{ id: 'kimi-k2-5', displayName: 'Kimi K2.5', tags: ['paid', 'cloud'] }],
  deepseek: [
    { id: 'deepseek-chat', displayName: 'DeepSeek V3', tags: ['paid', 'cloud', 'open'] },
    { id: 'deepseek-reasoner', displayName: 'DeepSeek R1', tags: ['paid', 'cloud', 'open', 'reasoning'] },
  ],
};

export const PROVIDERS: Provider[] = PROVIDER_DEFS.map((provider) => ({
  displayName: provider.displayName,
  providerId: provider.id,
  models: PROVIDER_MODELS[provider.id] ?? [],
}));

export function getModelsForProvider(providerId: string): Model[] {
  const provider = PROVIDERS.find((entry) => entry.providerId === providerId);
  return provider?.models ?? [];
}

export function getModelIdsForProvider(providerId: string): string[] {
  return getModelsForProvider(providerId).map((model) => model.id);
}

export function getDefaultModelForProvider(providerId: string): string | undefined {
  const models = getModelsForProvider(providerId);
  return models[0]?.id;
}

export function getModelDisplayName(modelId: string): string {
  const normalizedId = modelId.replace(/^(ollama|openrouter):/, '');

  for (const provider of PROVIDERS) {
    const model = provider.models.find((entry) => entry.id === normalizedId || entry.id === modelId);
    if (model) {
      return model.displayName;
    }
  }

  return normalizedId;
}
