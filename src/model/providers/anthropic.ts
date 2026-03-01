import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { ProviderAdapter, ProviderCallOptions, LlmResponse, ToolCall } from '../types.js';

/**
 * Convert a Zod schema to JSON Schema using Zod v4's built-in toJSONSchema.
 */
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

/**
 * Anthropic adapter — supports prompt caching via cache_control on system content blocks.
 */
export class AnthropicAdapter implements ProviderAdapter {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async call(options: ProviderCallOptions): Promise<LlmResponse> {
    const { model, systemPrompt, userPrompt, tools, outputSchema, signal } = options;

    // System prompt with cache_control for prompt caching (~90% savings)
    const systemContent: Anthropic.Messages.TextBlockParam[] = [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ];

    const messages: Anthropic.Messages.MessageParam[] = [
      { role: 'user', content: userPrompt },
    ];

    const requestParams: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: 4096,
      system: systemContent,
      messages,
    };

    // Structured output via tool_use: define a schema tool, force the model to use it
    if (outputSchema) {
      const jsonSchema = zodToJsonSchema(outputSchema);
      requestParams.tools = [
        {
          name: '_structured_output',
          description: 'Return structured output matching the required schema.',
          input_schema: jsonSchema as Anthropic.Messages.Tool['input_schema'],
        },
      ];
      requestParams.tool_choice = { type: 'tool', name: '_structured_output' };
    } else if (tools && tools.length > 0) {
      requestParams.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: zodToJsonSchema(t.schema) as Anthropic.Messages.Tool['input_schema'],
      }));
    }

    const response = await this.client.messages.create(requestParams, {
      signal: signal ?? undefined,
    });

    // Extract content text
    let content = '';
    const toolCalls: ToolCall[] = [];
    let structured: unknown = undefined;

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        if (outputSchema && block.name === '_structured_output') {
          // This is our structured output response
          structured = block.input;
          content = JSON.stringify(block.input);
        } else {
          toolCalls.push({
            id: block.id,
            name: block.name,
            args: block.input as Record<string, unknown>,
          });
        }
      }
    }

    // Extract usage
    const usage = response.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        }
      : undefined;

    return { content, toolCalls, usage, structured };
  }
}
