/**
 * Pure tool-call parsing for local models. No server dependencies: the server
 * adapter (providers/transformers.ts) and the in-browser local chat
 * (dashboard/ui/src/hybrid/core.ts) both import this file, so the two can never
 * disagree about what a tool call looks like. Keep it free of node/bun imports.
 */
import type { ToolCall } from './types.js';

/**
 * A call that names a skill as if it were a tool (granite emitted
 * `{"name": "month-end-close"}`) becomes the `skill` tool the agent supports.
 */
function asSkillCall(name: string, args: Record<string, unknown>): ToolCall {
  const skillArgs = Object.keys(args).length > 0 ? JSON.stringify(args) : undefined;
  return {
    id: crypto.randomUUID(),
    name: 'skill',
    args: skillArgs ? { skill: name, args: skillArgs } : { skill: name },
  };
}

/**
 * `{name, arguments|args}` → ToolCall; `arguments` may itself be a JSON string.
 * A name in `skillNames` (and not a tool) becomes a `skill` call.
 */
function toToolCall(
  raw: string,
  toolNames?: readonly string[],
  skillNames?: readonly string[],
): ToolCall | null {
  try {
    const parsed = JSON.parse(raw) as { name?: unknown; arguments?: unknown; args?: unknown };
    if (typeof parsed?.name !== 'string') return null;
    const isSkill = !!skillNames?.includes(parsed.name) && !toolNames?.includes(parsed.name);
    if (toolNames && !toolNames.includes(parsed.name) && !isSkill) return null;
    let args = parsed.arguments ?? parsed.args ?? {};
    if (typeof args === 'string') args = JSON.parse(args);
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
    if (isSkill) return asSkillCall(parsed.name, args as Record<string, unknown>);
    return { id: crypto.randomUUID(), name: parsed.name, args: args as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * The leading balanced `{...}` of `text` (string- and escape-aware), or null.
 * Granite emits the call and then keeps writing an invented answer, so the
 * JSON is a prefix of the output, not all of it.
 */
function leadingJsonObject(text: string): string | null {
  if (!text.startsWith('{')) return null;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(0, i + 1);
  }
  return null;
}

/** The leading JSON object of output with code fences removed, or null. */
function bareJsonCall(output: string): string | null {
  return leadingJsonObject(output.replace(/```(?:json)?/g, '').trim());
}

/**
 * Parse a tool call from model output: the documented
 * <tool_call>{...}</tool_call> form, or — only when it names one of
 * `toolNames` — a bare or fenced JSON object, which small models (granite-4.0-
 * micro) emit instead, often with `arguments` as a JSON string and often
 * followed by invented answer text, which is discarded.
 * Supports both 'arguments' (SmolLM3 native format) and 'args' (legacy).
 * A call naming one of `skillNames` is rewritten to `skill({ skill: name })`.
 */
export function parseToolCall(
  output: string,
  toolNames?: readonly string[],
  skillNames?: readonly string[],
): ToolCall | null {
  const tagged = output.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
  if (tagged) return toToolCall(tagged[1], undefined, skillNames);
  if (!toolNames?.length) return null;
  const bare = bareJsonCall(output);
  return bare ? toToolCall(bare, toolNames, skillNames) : null;
}

/**
 * True when output opens with a bare or fenced JSON tool call, without needing
 * the offered tool names. The browser local chat is offered no tools and does
 * not know the server's registry, so it recognises the shape instead: a JSON
 * object with a string `name` and an `arguments`/`args` object (or JSON string
 * of one). Any such object is a call attempt, never an answer. The server
 * parser, which does hold the names, accepts a subset of these.
 */
export function looksLikeBareToolCall(output: string): boolean {
  const bare = bareJsonCall(output);
  if (!bare) return false;
  try {
    const parsed = JSON.parse(bare) as { name?: unknown; arguments?: unknown; args?: unknown };
    if (typeof parsed?.name !== 'string') return false;
    if (parsed.arguments === undefined && parsed.args === undefined) return false;
  } catch {
    return false;
  }
  return toToolCall(bare) !== null;
}
