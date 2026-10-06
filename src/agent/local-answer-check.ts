/**
 * Final-answer check for local (Transformers.js) models.
 *
 * Small local models sometimes "answer" by copying the tool results out of the
 * iteration prompt (granite: "### spending_summary(period=month, …)\n{"data":…").
 * The agent re-prompts once on such an answer and, if the model repeats
 * itself, falls back to the latest result's own formatted summary.
 */

import type { ToolCallRecord } from './scratchpad.js';

/**
 * True when the answer is a tool-result block: it starts with the iteration
 * prompt's "### <tool>(" heading for a tool called this run, or carries the
 * raw `{"data":` JSON every tool result is wrapped in.
 */
export function isToolResultEcho(answer: string, calledTools: Iterable<string>): boolean {
  const heading = /^\s*###\s*(\w+)\(/.exec(answer);
  if (heading && new Set(calledTools).has(heading[1])) return true;
  return /\{\s*"data"\s*:/.test(answer);
}

/**
 * A deterministic answer from the tool results: the latest result's
 * `formatted` summary (spending_summary, transaction_search, …), or a short
 * message — never the raw data.
 */
export function toolResultsFallback(records: readonly ToolCallRecord[]): string {
  for (const record of [...records].reverse()) {
    const formatted = formattedOf(record.result);
    if (formatted) return `Here's what I found:\n\n\`\`\`\n${formatted}\n\`\`\``;
  }
  return "I found the data but couldn't summarize it. Try rephrasing the question or asking about one part of it.";
}

function formattedOf(result: string): string | null {
  try {
    const formatted = (JSON.parse(result) as { data?: { formatted?: unknown } })?.data?.formatted;
    return typeof formatted === 'string' && formatted.trim() ? formatted.trim() : null;
  } catch {
    return null;
  }
}
