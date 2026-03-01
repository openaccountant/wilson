import type { LlmResponse } from '../model/types.js';

/**
 * Extract text content from an LlmResponse.
 */
export function extractTextContent(response: LlmResponse): string {
  return response.content;
}

/**
 * Check if an LlmResponse has tool calls.
 */
export function hasToolCalls(response: LlmResponse): boolean {
  return response.toolCalls.length > 0;
}
