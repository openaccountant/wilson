import { z } from 'zod';
import { DEFAULT_SYSTEM_PROMPT } from '../agent/prompts.js';
import type { LlmResponse, ToolDef } from './types.js';
import { getAdapter } from './providers/index.js';
import { logger } from '../utils/logger.js';
import { classifyError, isNonRetryableError } from '../utils/errors.js';
import { resolveProvider, getProviderById } from '../providers.js';

export const DEFAULT_PROVIDER = 'openai';
export const DEFAULT_MODEL = 'gpt-5.2';

/**
 * Gets the fast model variant for the given provider.
 * Falls back to the provided model if no fast variant is configured (e.g., Ollama).
 */
export function getFastModel(modelProvider: string, fallbackModel: string): string {
  return getProviderById(modelProvider)?.fastModel ?? fallbackModel;
}

// Generic retry helper with exponential backoff
async function withRetry<T>(fn: () => Promise<T>, provider: string, maxAttempts = 3): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const errorType = classifyError(message);
      logger.error(`[${provider} API] ${errorType} error (attempt ${attempt + 1}/${maxAttempts}): ${message}`);

      if (isNonRetryableError(message)) {
        throw new Error(`[${provider} API] ${message}`);
      }

      if (attempt === maxAttempts - 1) {
        throw new Error(`[${provider} API] ${message}`);
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new Error('Unreachable');
}

export interface CallLlmOptions {
  model?: string;
  systemPrompt?: string;
  outputSchema?: z.ZodType<unknown>;
  tools?: ToolDef[];
  signal?: AbortSignal;
}

export interface LlmResult {
  response: LlmResponse;
  usage?: LlmResponse['usage'];
}

/**
 * Central LLM call facade.
 * Resolves provider → gets adapter → calls adapter.call().
 * Always returns LlmResponse — no string | AIMessage branching downstream.
 */
export async function callLlm(prompt: string, options: CallLlmOptions = {}): Promise<LlmResult> {
  const { model = DEFAULT_MODEL, systemPrompt, outputSchema, tools, signal } = options;
  const finalSystemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;

  const provider = resolveProvider(model);

  // Strip prefix for providers that use it for routing but not for the API call
  let apiModel = model;
  if (provider.id === 'openrouter') {
    apiModel = model.replace(/^openrouter:/, '');
  } else if (provider.id === 'litellm') {
    apiModel = model.replace(/^litellm:/, '');
  } else if (provider.id === 'ollama') {
    apiModel = model.replace(/^ollama:/, '');
  }

  const adapter = getAdapter(provider.id);

  const response = await withRetry(
    () =>
      adapter.call({
        model: apiModel,
        systemPrompt: finalSystemPrompt,
        userPrompt: prompt,
        tools,
        outputSchema,
        signal,
      }),
    provider.displayName,
  );

  return { response, usage: response.usage };
}
