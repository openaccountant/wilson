import { generateText, generateObject, tool } from 'ai';
import type { LanguageModel, LanguageModelUsage } from 'ai';
import type { ProviderAdapter, ProviderCallOptions, LlmResponse } from '../types.js';

export class VercelAiAdapter implements ProviderAdapter {
  constructor(private modelFactory: (modelName: string) => LanguageModel) {}

  async call(options: ProviderCallOptions): Promise<LlmResponse> {
    const { model, systemPrompt, userPrompt, tools, outputSchema, signal } = options;
    const llmModel = this.modelFactory(model);
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userPrompt },
    ];

    // Structured output path
    if (outputSchema) {
      const result = await generateObject({ model: llmModel, messages, schema: outputSchema });
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
      messages,
      tools: vercelTools,
      abortSignal: signal,
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
