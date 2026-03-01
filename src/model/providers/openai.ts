import OpenAI from 'openai';
import { z } from 'zod';
import type { ProviderAdapter, ProviderCallOptions, LlmResponse, ToolCall } from '../types.js';

/**
 * Convert a Zod schema to JSON Schema using Zod v4's built-in toJSONSchema.
 */
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

/**
 * OpenAI-compatible adapter — covers OpenAI, xAI, OpenRouter, Moonshot, DeepSeek, Ollama.
 * All these providers expose the same /v1/chat/completions endpoint.
 */
export class OpenAIAdapter implements ProviderAdapter {
  private client: OpenAI;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL });
  }

  async call(options: ProviderCallOptions): Promise<LlmResponse> {
    const { model, systemPrompt, userPrompt, tools, outputSchema, signal } = options;

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const requestOptions: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model,
      messages,
    };

    // Structured output: use json_object response format + schema hint in system prompt
    if (outputSchema) {
      const jsonSchema = zodToJsonSchema(outputSchema);
      requestOptions.response_format = { type: 'json_object' };
      // Append schema hint to system message so the model knows the expected shape
      messages[0] = {
        role: 'system',
        content: `${systemPrompt}\n\nRespond with valid JSON matching this schema:\n${JSON.stringify(jsonSchema)}`,
      };
    } else if (tools && tools.length > 0) {
      // Tool definitions
      requestOptions.tools = tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: zodToJsonSchema(t.schema),
        },
      }));
    }

    const response = await this.client.chat.completions.create(requestOptions, {
      signal: signal ?? undefined,
    });

    const choice = response.choices[0];
    const message = choice?.message;

    // Extract tool calls — only from function-type tool calls
    const toolCalls: ToolCall[] = (message?.tool_calls ?? [])
      .filter((tc): tc is OpenAI.ChatCompletionMessageToolCall & { type: 'function' } => tc.type === 'function')
      .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>,
      }));

    // Extract usage
    const usage = response.usage
      ? {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        }
      : undefined;

    const content = message?.content ?? '';

    // If outputSchema was provided, parse the JSON content
    if (outputSchema && content) {
      try {
        const parsed = JSON.parse(content);
        return { content, toolCalls, usage, structured: parsed };
      } catch {
        return { content, toolCalls, usage };
      }
    }

    return { content, toolCalls, usage };
  }
}
