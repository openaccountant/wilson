import { z } from 'zod';
import { DEFAULT_SYSTEM_PROMPT } from '../agent/prompts.js';
import type { LlmResponse, ToolDef } from './types.js';
import { getAdapter } from './providers/index.js';
import { buildRepairPrompt, LlmValidationError, validateStructuredOutput } from './structured-output.js';
import { logger } from '../utils/logger.js';
import { classifyError, isNonRetryableError } from '../utils/errors.js';
import { resolveProvider, getProviderById } from '../providers.js';
import { traceStore } from '../utils/trace-store.js';
import { interactionStore } from '../utils/interaction-store.js';

export const DEFAULT_PROVIDER = 'ollama';
export const DEFAULT_MODEL = 'ollama:qwen3:8b';

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
  runId?: string;
  sequenceNum?: number;
  callType?: string;
  /** Generation cap. Honored by the Transformers adapter; other adapters ignore it in this slice. */
  maxTokens?: number;
}

export interface LlmResult {
  response: LlmResponse;
  usage?: LlmResponse['usage'];
  interactionId?: number | null;
  /** Id of the trace row recorded for this call (see trace-store.ts). */
  traceId: string;
  /** The real measured wall-clock duration of this call, in ms. */
  durationMs: number;
}

/**
 * Central LLM call facade.
 * Resolves provider → gets adapter → calls adapter.call().
 * Always returns LlmResponse — no string | AIMessage branching downstream.
 */
export async function callLlm(prompt: string, options: CallLlmOptions = {}): Promise<LlmResult> {
  const { model = DEFAULT_MODEL, systemPrompt, outputSchema, tools, signal, runId, sequenceNum, callType } = options;
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
  } else if (provider.id === 'transformers') {
    apiModel = model.replace(/^transformers:/, '');
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

    // Structured-output gate: when a schema was supplied, validate what came back
    // (falling back to parsing the response content) and give the model exactly one
    // schema-aware repair re-prompt. If the repair still violates the schema, reject
    // with a typed error instead of returning unvalidated data.
    let finalResponse = response;
    if (outputSchema) {
      const first = validateStructuredOutput(response, outputSchema);
      if (first.ok) {
        finalResponse = first.response;
      } else {
        logger.warn(`Structured output failed schema validation; requesting one repair`, {
          model: apiModel,
          provider: provider.id,
          issues: first.issues,
        });
        finalResponse = await withRetry(
          () =>
            adapter.call({
              model: apiModel,
              systemPrompt: finalSystemPrompt,
              userPrompt: buildRepairPrompt(prompt, response, outputSchema, first.issues),
              outputSchema,
              signal,
            }),
          provider.displayName,
        );
        const second = validateStructuredOutput(finalResponse, outputSchema);
        if (!second.ok) {
          throw new LlmValidationError(
            `LLM structured output failed schema validation after one repair attempt: ${second.issues.join('; ')}`,
            second.issues,
            finalResponse,
          );
        }
        finalResponse = second.response;
      }
    }

    const durationMs = Date.now() - startTime;
    const inputTokens = finalResponse.usage?.inputTokens ?? 0;
    const outputTokens = finalResponse.usage?.outputTokens ?? 0;
    const totalTokens = finalResponse.usage?.totalTokens ?? 0;
    const toolCallCount = finalResponse.toolCalls?.length ?? 0;

    const trace = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: new Date().toISOString(),
      model: apiModel,
      provider: provider.id,
      promptLength: promptChars,
      responseLength: finalResponse.content.length,
      inputTokens,
      outputTokens,
      totalTokens,
      durationMs,
      status: 'ok' as const,
    };

    traceStore.record(trace);

    const interactionId = interactionStore.recordInteraction({
      runId: runId ?? 'standalone',
      sequenceNum: sequenceNum ?? 0,
      callType: callType ?? 'standalone',
      model: apiModel,
      provider: provider.id,
      systemPrompt: finalSystemPrompt,
      userPrompt: prompt,
      responseContent: finalResponse.content,
      toolCalls: finalResponse.toolCalls ?? [],
      toolDefs: (tools ?? []).map(t => t.name),
      usage: { inputTokens, outputTokens, totalTokens },
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
      responseChars: finalResponse.content.length,
      toolCalls: toolCallCount,
    });

    // Trace id + measured duration ride back to callers so every on-screen
    // timer can be sourced from a recorded trace row (see demo/showdown.ts).
    return {
      response: finalResponse,
      usage: finalResponse.usage,
      interactionId,
      traceId: trace.id,
      durationMs: trace.durationMs,
    };
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
