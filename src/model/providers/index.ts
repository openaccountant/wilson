import type { ProviderAdapter } from '../types.js';
import { OpenAIAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';
import { GoogleAdapter } from './google.js';

/**
 * Adapter registry — lazily initialized per provider.
 * No API keys needed at import time; adapters are created on first use.
 */
const adapters = new Map<string, ProviderAdapter>();

function getApiKey(envVar: string): string {
  const apiKey = process.env[envVar];
  if (!apiKey) {
    throw new Error(`[LLM] ${envVar} not found in environment variables`);
  }
  return apiKey;
}

/** OpenAI-compatible provider configs: provider id → { envVar, baseURL? } */
const OPENAI_COMPAT: Record<string, { envVar: string; baseURL?: string }> = {
  openai: { envVar: 'OPENAI_API_KEY' },
  xai: { envVar: 'XAI_API_KEY', baseURL: 'https://api.x.ai/v1' },
  openrouter: { envVar: 'OPENROUTER_API_KEY', baseURL: 'https://openrouter.ai/api/v1' },
  moonshot: { envVar: 'MOONSHOT_API_KEY', baseURL: 'https://api.moonshot.cn/v1' },
  deepseek: { envVar: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' },
  litellm: { envVar: 'LITELLM_API_KEY', baseURL: process.env.LITELLM_BASE_URL || 'http://localhost:4000/v1' },
  ollama: { envVar: '', baseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1' },
};

/**
 * Get (or create) the adapter for a given provider ID.
 */
export function getAdapter(providerId: string): ProviderAdapter {
  const cached = adapters.get(providerId);
  if (cached) return cached;

  let adapter: ProviderAdapter;

  if (providerId === 'anthropic') {
    adapter = new AnthropicAdapter(getApiKey('ANTHROPIC_API_KEY'));
  } else if (providerId === 'google') {
    adapter = new GoogleAdapter(getApiKey('GOOGLE_API_KEY'));
  } else {
    // OpenAI-compatible providers
    const config = OPENAI_COMPAT[providerId] ?? OPENAI_COMPAT.openai;
    const apiKey = config.envVar ? getApiKey(config.envVar) : 'ollama';
    adapter = new OpenAIAdapter(apiKey, config.baseURL);
  }

  adapters.set(providerId, adapter);
  return adapter;
}
