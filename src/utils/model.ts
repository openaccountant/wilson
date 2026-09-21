import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PROVIDERS as PROVIDER_DEFS } from '../providers.js';

export type ModelTag = 'paid' | 'open' | 'local' | 'cloud' | 'small' | 'large' | 'reasoning' | 'webgpu';

export interface Model {
  id: string;
  displayName: string;
  tags?: ModelTag[];
  downloadSize?: string; // approximate first-run download size
}

interface Provider {
  displayName: string;
  providerId: string;
  models: Model[];
}

const PROVIDER_MODELS: Record<string, Model[]> = {
  ollama: [
    { id: 'ollama:qwen3:8b',        displayName: 'Qwen3 8B (local)',        tags: ['local', 'open'] },
    { id: 'ollama:qwen3:4b',        displayName: 'Qwen3 4B (local)',        tags: ['local', 'open', 'small'] },
    { id: 'ollama:qwen3:0.6b',      displayName: 'Qwen3 0.6B (local)',      tags: ['local', 'open', 'small'] },
    { id: 'ollama:granite4:3b',     displayName: 'Granite 4 3B (local)',    tags: ['local', 'open', 'small'] },
    { id: 'ollama:granite4:tiny-h', displayName: 'Granite 4 MoE (local)',   tags: ['local', 'open', 'small'] },
    { id: 'ollama:ministral-3:3b',  displayName: 'Ministral 3B (local)',    tags: ['local', 'open', 'small'] },
    { id: 'ollama:gemma3:4b',       displayName: 'Gemma3 4B (local)',       tags: ['local', 'open', 'small'] },
    { id: 'ollama:smollm2:1.7b',    displayName: 'SmolLM2 1.7B (local)',    tags: ['local', 'open', 'small'] },
    { id: 'ollama:gemma3:1b',       displayName: 'Gemma3 1B (local)',       tags: ['local', 'open', 'small'] },
    { id: 'ollama:granite4:350m',   displayName: 'Granite 4 350M (local)',  tags: ['local', 'open', 'small'] },
  ],
  transformers: [
    // WebGPU models — require a GPU that ORT's bundled WebGPU EP can drive
    { id: 'transformers:onnx-community/granite-4.0-micro-ONNX-web', displayName: 'Granite 4.0 Micro 3B (WebGPU)', tags: ['local', 'small', 'webgpu'], downloadSize: '~3.2GB' },
    { id: 'transformers:onnx-community/LFM2-1.2B-Tool-ONNX',        displayName: 'LFM2 1.2B Tool (WebGPU)',       tags: ['local', 'small', 'webgpu'], downloadSize: '~1.2GB' },
    { id: 'transformers:onnx-community/granite-4.0-350m-ONNX-web',  displayName: 'Granite 4.0 350M (WebGPU)',     tags: ['local', 'small', 'webgpu'], downloadSize: '~350MB' },
    { id: 'transformers:onnx-community/Qwen3-0.6B-ONNX',            displayName: 'Qwen3 0.6B (WebGPU)',           tags: ['local', 'small', 'webgpu'], downloadSize: '~600MB' },
    // CPU/WASM models — work out of the box, no GPU required
    { id: 'transformers:HuggingFaceTB/SmolLM3-3B-ONNX',             displayName: 'SmolLM3 3B (CPU)',              tags: ['local', 'small'],            downloadSize: '~2.0GB' },
    { id: 'transformers:onnx-community/Qwen2.5-1.5B-Instruct',      displayName: 'Qwen 2.5 1.5B (CPU)',           tags: ['local', 'small'],            downloadSize: '~900MB' },
  ],
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

/** Slug prefixes ("ollama:", "openai-compatible:", ...) used for routing only. */
const SLUG_PREFIXES = PROVIDER_DEFS.map((p) => p.modelPrefix).filter((prefix) =>
  prefix.endsWith(':'),
);

export function getModelDisplayName(modelId: string): string {
  const slugPrefix = SLUG_PREFIXES.find((prefix) => modelId.startsWith(prefix));
  const normalizedId = slugPrefix ? modelId.slice(slugPrefix.length) : modelId;

  for (const provider of PROVIDERS) {
    const model = provider.models.find((entry) => entry.id === normalizedId || entry.id === modelId);
    if (model) {
      return model.displayName;
    }
  }

  return normalizedId;
}

/**
 * Returns true if the model has already been downloaded to the local cache.
 * Takes the bare repo id ("HuggingFaceTB/SmolLM3-3B-ONNX" — no `transformers:`
 * prefix): the transformers.js cache lives at
 * ~/.openaccountant/models/models--{org}--{name}/.
 */
export function isTransformersModelCached(modelId: string): boolean {
  const cacheName = `models--${modelId.replace('/', '--')}`;
  return existsSync(join(homedir(), '.openaccountant', 'models', cacheName));
}
