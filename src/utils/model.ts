import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PROVIDERS as PROVIDER_DEFS } from '../providers.js';
import type { OnnxDtype, TransformersDevice } from '../model/transformers-dtype.js';

export type ModelTag = 'paid' | 'open' | 'local' | 'cloud' | 'small' | 'large' | 'reasoning' | 'webgpu';

export interface Model {
  id: string;
  displayName: string;
  tags?: ModelTag[];
  downloadSize?: string; // approximate first-run download size
  /** transformers only: where the pipeline runs (agrees with the 'webgpu' tag). */
  device?: TransformersDevice;
  /** transformers only: the ONNX weights to load (onnx/model_<dtype>.onnx). */
  dtype?: OnnxDtype;
  /**
   * transformers only: the 40-hex Hub commit sha every file is loaded from.
   * Never `main`: a pinned revision makes download URLs and cache keys
   * immutable, so a cached model can't silently mix two upstream versions.
   * Recorded with scripts/record-hf-fixture.ts; checked against the fixture by
   * src/__tests__/transformers-dtype.test.ts.
   */
  revision?: string;
}

interface Provider {
  displayName: string;
  providerId: string;
  models: Model[];
}

/**
 * Largest single-file ONNX (one protobuf, no .onnx_data shards) a WebGPU
 * catalog entry may pin. ORT-web fails session creation with std::bad_alloc on
 * Qwen3 1.7B q4f16, a single 1,426,069,098-byte file, in Chromium 153 on an
 * M4 Pro, while Qwen3 0.6B q4f16 (569,789,750 bytes) loads on the same setup
 * (#154; specs/eval/2026-10-03-round3-run.md). The cap sits between the two.
 * Sharded exports are not limited by it. Enforced against the recorded Hub
 * file lists by src/__tests__/transformers-dtype.test.ts.
 */
export const WEBGPU_SINGLE_FILE_ONNX_MAX_BYTES = 1_000_000_000;

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
    // Every entry pins `device` and `dtype`. The dtype names the exact ONNX
    // file Transformers.js loads (onnx/model_<dtype>.onnx): repos publish
    // different subsets, and a missing file is a hard "Could not locate file"
    // failure. src/__tests__/transformers-dtype.test.ts checks every pin
    // against the recorded Hub file lists. downloadSize is the size at that dtype.
    //
    // WebGPU models — require a GPU that ORT's bundled WebGPU EP can drive.
    // A pinned ONNX file without external-data shards must stay under
    // WEBGPU_SINGLE_FILE_ONNX_MAX_BYTES (above): Qwen3 1.7B q4f16 was dropped
    // for exactly that (#154).
    { id: 'transformers:onnx-community/granite-4.0-micro-ONNX-web', displayName: 'Granite 4.0 Micro 3B (WebGPU)', tags: ['local', 'small', 'webgpu'], device: 'webgpu', dtype: 'q4f16', revision: '055c9bd9db8f5e47bebd17246b0c614ffe5e8a13', downloadSize: '~2.3GB' },
    { id: 'transformers:LiquidAI/LFM2.5-1.2B-Instruct-ONNX',        displayName: 'LFM2.5 1.2B Instruct (WebGPU)', tags: ['local', 'small', 'webgpu'], device: 'webgpu', dtype: 'q4f16', revision: '10f72e70abf67ac0fd7ebf15bc5854726891d864', downloadSize: '~760MB' },
    { id: 'transformers:onnx-community/LFM3-1.7B-ONNX',            displayName: 'LFM3 1.7B (WebGPU)',            tags: ['local', 'small', 'webgpu'], device: 'webgpu', dtype: 'q4f16', revision: 'ab9fec4c681a25bec3b48b0b97a62fc2660a2985', downloadSize: '~1.1GB' },
    { id: 'transformers:onnx-community/granite-4.0-350m-ONNX-web',  displayName: 'Granite 4.0 350M (WebGPU)',     tags: ['local', 'small', 'webgpu'], device: 'webgpu', dtype: 'q4f16', revision: '62fc8f345c8aed0e1a28f856dc7e79b4cdb55cae', downloadSize: '~350MB' },
    { id: 'transformers:onnx-community/Qwen3-0.6B-ONNX',            displayName: 'Qwen3 0.6B (WebGPU)',           tags: ['local', 'small', 'webgpu'], device: 'webgpu', dtype: 'q4f16', revision: '58ca03a5e7b354b480b1a82b34bde8dc7b854cc0', downloadSize: '~570MB' },
    // Gemma 4 E2B: q4 ONLY, never q4f16 (Gemma fp16 activation overflow, ORT#26732). Text-only load = embed_tokens_q4 + decoder_model_merged_q4.
    { id: 'transformers:onnx-community/gemma-4-E2B-it-ONNX',        displayName: 'Gemma 4 E2B (WebGPU)',          tags: ['local', 'small', 'webgpu'], device: 'webgpu', dtype: 'q4',    revision: '6f21c99d7e18237f8d2ce92aadfdbfeba877f63a', downloadSize: '~3.6GB' },
    // CPU/WASM models — work out of the box, no GPU required
    { id: 'transformers:HuggingFaceTB/SmolLM3-3B-ONNX',             displayName: 'SmolLM3 3B (CPU)',              tags: ['local', 'small'],            device: 'cpu',    dtype: 'q4',    revision: '583cadea149c60c0a737786f61ace5775e165d99', downloadSize: '~2.8GB' },
    { id: 'transformers:onnx-community/Qwen2.5-1.5B-Instruct',      displayName: 'Qwen 2.5 1.5B (CPU)',           tags: ['local', 'small'],            device: 'cpu',    dtype: 'q4',    revision: 'd54957e3af1be04546436e874a60fe386041b244', downloadSize: '~1.8GB' },
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

export function getModelDisplayName(modelId: string): string {
  const normalizedId = modelId.replace(/^(ollama|openrouter|transformers):/, '');

  for (const provider of PROVIDERS) {
    const model = provider.models.find((entry) => entry.id === normalizedId || entry.id === modelId);
    if (model) {
      return model.displayName;
    }
  }

  return normalizedId;
}

/**
 * The transformers catalog entry for a Hub repo, accepting the id with or
 * without the `transformers:` prefix. Undefined for user-typed repos.
 */
export function getTransformersCatalogEntry(modelId: string): Model | undefined {
  const id = modelId.startsWith('transformers:') ? modelId : `transformers:${modelId}`;
  return getModelsForProvider('transformers').find((m) => m.id === id);
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
