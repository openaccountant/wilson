import type { ProviderAdapter } from '../types.js';
import { VercelAiAdapter } from './vercel-ai.js';
import { TransformersAdapter } from './transformers.js';
import { openai, createOpenAI } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';

/**
 * Adapter registry — lazily initialized per provider.
 * Vercel AI SDK reads OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY from env automatically.
 * Ollama uses the OpenAI-compatible endpoint at /v1 (no API key needed).
 */
const adapters = new Map<string, ProviderAdapter>();

export function getAdapter(providerId: string): ProviderAdapter {
  const cached = adapters.get(providerId);
  if (cached) return cached;

  let adapter: ProviderAdapter;

  switch (providerId) {
    case 'anthropic':
      adapter = new VercelAiAdapter((m) => anthropic(m));
      break;
    case 'google':
      adapter = new VercelAiAdapter((m) => google(m));
      break;
    case 'xai':
      adapter = new VercelAiAdapter((m) =>
        createOpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: 'https://api.x.ai/v1' })(m),
      );
      break;
    case 'openrouter':
      adapter = new VercelAiAdapter((m) =>
        createOpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' })(m),
      );
      break;
    case 'deepseek':
      adapter = new VercelAiAdapter((m) =>
        createOpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' })(m),
      );
      break;
    case 'moonshot':
      adapter = new VercelAiAdapter((m) =>
        createOpenAI({ apiKey: process.env.MOONSHOT_API_KEY, baseURL: 'https://api.moonshot.cn/v1' })(m),
      );
      break;
    case 'litellm':
      adapter = new VercelAiAdapter((m) =>
        createOpenAI({
          apiKey: process.env.LITELLM_API_KEY,
          baseURL: process.env.LITELLM_BASE_URL || 'http://localhost:4000/v1',
        })(m),
      );
      break;
    case 'ollama':
      // Ollama exposes an OpenAI-compatible endpoint at /v1
      adapter = new VercelAiAdapter((m) =>
        createOpenAI({
          apiKey: 'ollama',
          baseURL: `${process.env.OLLAMA_BASE_URL || 'http://localhost:11434'}/v1`,
        })(m),
      );
      break;
    case 'transformers':
      adapter = new TransformersAdapter();
      break;
    default:
      // openai + unknown providers default to OpenAI
      adapter = new VercelAiAdapter((m) => openai(m));
      break;
  }

  adapters.set(providerId, adapter);
  return adapter;
}
