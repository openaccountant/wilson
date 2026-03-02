import { z } from 'zod';
import { DEFAULT_SYSTEM_PROMPT } from '../agent/prompts.js';
import type { LlmResponse, ToolDef } from './types.js';
import { getAdapter } from './providers/index.js';
import { logger } from '../utils/logger.js';
import { classifyError, isNonRetryableError } from '../utils/errors.js';
import { resolveProvider, getProviderById } from '../providers.js';
import { traceStore } from '../utils/trace-store.js';

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
  const startTime = Date.now();
  const promptChars = prompt.length + finalSystemPrompt.length;
  const toolCount = tools?.length ?? 0;

  logger.debug(`LLM call start`, { model: apiModel, provider: provider.id, promptChars, tools: toolCount });

  try {
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

    const durationMs = Date.now() - startTime;
    const inputTokens = response.usage?.inputTokens ?? 0;
    const outputTokens = response.usage?.outputTokens ?? 0;
    const totalTokens = response.usage?.totalTokens ?? 0;
    const toolCallCount = response.toolCalls?.length ?? 0;

    traceStore.record({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: new Date().toISOString(),
      model: apiModel,
      provider: provider.id,
      promptLength: promptChars,
      responseLength: response.content.length,
      inputTokens,
      outputTokens,
      totalTokens,
      durationMs,
      status: 'ok',
    });

    logger.info(`LLM call completed`, {
      model: apiModel,
      provider: provider.id,
      durationMs,
      inputTokens,
      outputTokens,
      totalTokens,
      responseChars: response.content.length,
      toolCalls: toolCallCount,
    });

    return { response, usage: response.usage };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);

    traceStore.record({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: new Date().toISOString(),
      model: apiModel,
      provider: provider.id,
      promptLength: promptChars,
      responseLength: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      durationMs,
      status: 'error',
      error: errorMsg,
    });

    logger.error(`LLM call failed`, { model: apiModel, provider: provider.id, durationMs, error: errorMsg });
    throw error;
  }
}
