import { generateText, generateObject, tool } from 'ai';
import type { LanguageModel, LanguageModelUsage } from 'ai';
import { LlmTimeoutError } from '../local-timeout.js';
import type { ProviderAdapter, ProviderCallOptions, LlmResponse } from '../types.js';

export class VercelAiAdapter implements ProviderAdapter {
  constructor(private modelFactory: (modelName: string) => LanguageModel) {}

  async call(options: ProviderCallOptions): Promise<LlmResponse> {
    const { timeoutMs } = options;
    if (!timeoutMs) return this.callOnce(options, options.signal);

    // Our own timer, separate from the caller's signal, so a timeout is
    // distinguishable from a caller abort (which must propagate untouched).
    const timer = new AbortController();
    const handle = setTimeout(() => timer.abort(), timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timer.signal]) : timer.signal;
    try {
      return await this.callOnce(options, signal);
    } catch (e) {
      if (timer.signal.aborted && !options.signal?.aborted) throw new LlmTimeoutError(timeoutMs);
      throw e;
    } finally {
      clearTimeout(handle);
    }
  }

  private async callOnce(options: ProviderCallOptions, signal: AbortSignal | undefined): Promise<LlmResponse> {
    const { model, systemPrompt, userPrompt, tools, outputSchema } = options;
    const llmModel = this.modelFactory(model);
    // AI SDK 7 rejects role:'system' inside messages; system text goes through `instructions`.
    const messages = [{ role: 'user' as const, content: userPrompt }];
    // callLlm's withRetry owns retries; the SDK's own (2 by default) multiplied them, so an
    // unreachable model took ~20 s per call to fail.
    const maxRetries = 0;

    // Structured output path
    if (outputSchema) {
      const result = await generateObject({ model: llmModel, instructions: systemPrompt, messages, schema: outputSchema, abortSignal: signal, maxRetries });
      return {
        content: JSON.stringify(result.object),
        toolCalls: [],
        usage: mapUsage(result.usage),
        structured: result.object,
      };
    }

    // Tool calling / plain text path
    const vercelTools =
      tools && tools.length > 0
        ? Object.fromEntries(
            tools.map((t) => [
              t.name,
              tool({ description: t.description, inputSchema: t.schema }),
            ]),
          )
        : undefined;

    const result = await generateText({
      model: llmModel,
      instructions: systemPrompt,
      messages,
      tools: vercelTools,
      abortSignal: signal,
      maxRetries,
    });

    return {
      content: result.text,
      toolCalls: (result.toolCalls ?? []).map((tc) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        args: (tc as unknown as { input: Record<string, unknown> }).input ?? {},
      })),
      usage: mapUsage(result.usage),
    };
  }
}

function mapUsage(usage: LanguageModelUsage | undefined) {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
  };
}
