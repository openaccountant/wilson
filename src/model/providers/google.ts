import { GoogleGenerativeAI, type GenerateContentResult } from '@google/generative-ai';
import { z } from 'zod';
import type { ProviderAdapter, ProviderCallOptions, LlmResponse, ToolCall } from '../types.js';

/**
 * Convert a Zod schema to JSON Schema using Zod v4's built-in toJSONSchema.
 */
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

/**
 * Google Gemini adapter.
 */
export class GoogleAdapter implements ProviderAdapter {
  private genAI: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async call(options: ProviderCallOptions): Promise<LlmResponse> {
    const { model, systemPrompt, userPrompt, tools, outputSchema, signal } = options;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modelConfig: Record<string, any> = {
      systemInstruction: systemPrompt,
    };

    // Structured output
    if (outputSchema) {
      const jsonSchema = zodToJsonSchema(outputSchema);
      modelConfig.generationConfig = {
        responseMimeType: 'application/json',
        responseSchema: jsonSchema,
      };
    } else if (tools && tools.length > 0) {
      modelConfig.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: zodToJsonSchema(t.schema),
          })),
        },
      ];
    }

    const generativeModel = this.genAI.getGenerativeModel({
      model,
      ...modelConfig,
    });

    // AbortSignal support: wrap in a race with abort
    let result: GenerateContentResult;
    if (signal) {
      result = await Promise.race([
        generativeModel.generateContent(userPrompt),
        new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
            once: true,
          });
        }),
      ]);
    } else {
      result = await generativeModel.generateContent(userPrompt);
    }

    const response = result.response;
    const text = response.text?.() ?? '';

    // Extract tool calls from function call parts
    const toolCalls: ToolCall[] = [];
    const candidates = response.candidates ?? [];
    for (const candidate of candidates) {
      for (const part of candidate.content?.parts ?? []) {
        if ('functionCall' in part && part.functionCall) {
          toolCalls.push({
            id: `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: part.functionCall.name,
            args: (part.functionCall.args as Record<string, unknown>) ?? {},
          });
        }
      }
    }

    // Extract usage
    const meta = response.usageMetadata;
    const usage = meta
      ? {
          inputTokens: meta.promptTokenCount ?? 0,
          outputTokens: meta.candidatesTokenCount ?? 0,
          totalTokens: meta.totalTokenCount ?? 0,
        }
      : undefined;

    // Structured output parsing
    let structured: unknown = undefined;
    if (outputSchema && text) {
      try {
        structured = JSON.parse(text);
      } catch {
        // JSON parse failed — leave structured undefined
      }
    }

    return { content: text, toolCalls, usage, structured };
  }
}
