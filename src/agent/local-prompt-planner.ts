/**
 * Token-budget planner for local (Transformers.js) model calls — design
 * 2026-10-03 §5.7.
 *
 * One function accounts for every prompt token (system prompt with DB
 * contexts, selected tool schemas and the names-only index, chat history or
 * tool results, the query) with the model's own tokenizer, and trims in a
 * fixed order when over budget − safety:
 *
 *   1. chat history, oldest turns first (first call of a run), or
 *      tool results, oldest first, each replaced by a one-line stub (later calls)
 *   2. unused selected tools, lowest priority first, down to the protected set
 *      (core, named, called) — they move to the names-only index, still callable
 *   3. skill descriptions, down to names (`compactSystem`)
 *
 * The query is never trimmed. On a hard (WebGPU) budget, a prompt that still
 * exceeds it raises LocalPromptTooLargeError here instead of after a
 * minute-long prefill. On a soft (CPU, latency-only) budget it is sent anyway.
 */

import type { ToolDef } from '../model/types.js';
import { buildToolSystemPrompt, LocalPromptTooLargeError } from '../model/providers/transformers.js';
import { buildBudgetedHistoryContext, type HistoryEntry } from '../utils/history-context.js';

/** Template drift, the chat template itself, and the off-by-few between planner and adapter. */
export const PLANNER_SAFETY_TOKENS = 256;

/** Chat-template overhead of a system + user message pair (13 measured on granite). */
export const CHAT_TEMPLATE_TOKENS = 16;

/** CPU transformers models have no hard limit; prefill time scales with prompt length. */
export const CPU_SOFT_PROMPT_BUDGET = 12_000;

export interface LocalPromptInput {
  /** For the error message. */
  model: string;
  budget: number;
  /** True on WebGPU (over budget fails); false for the soft CPU budget. */
  hardLimit: boolean;
  safety?: number;
  countTokens: (text: string) => number;
  /** System prompt incl. DB contexts and the skills block, before tool injection. */
  system: string;
  /** The same prompt with skill names only — the last trim step. */
  compactSystem?: string;
  /** Selected tools, highest priority first. */
  tools: ToolDef[];
  /** Selected tools that are never trimmed (core, named, called). */
  protectedTools: ReadonlySet<string>;
  /** Registered tools sent by name only. */
  toolIndex: string[];
  query: string;
  /** First call of a run: recent chat turns, oldest first. */
  history?: HistoryEntry[];
  /** Later calls: formatted tool results (oldest first) and how to render the iteration prompt around them. */
  results?: { blocks: string[]; render: (joinedResults: string) => string };
}

export interface LocalPromptPlan {
  /** Pass to callLlm as systemPrompt / tools / toolIndex / prompt. */
  systemPrompt: string;
  tools: ToolDef[];
  toolIndex: string[];
  userPrompt: string;
  tokens: {
    /** System prompt with DB contexts and skills, before tools. */
    fixed: number;
    /** Tool schemas, wrapper text and index. */
    tools: number;
    history: number;
    results: number;
    template: number;
    total: number;
    budget: number;
  };
  /** One line per trim step taken, in order. */
  trimmed: string[];
}

export function planLocalPrompt(input: LocalPromptInput): LocalPromptPlan {
  const { countTokens, query } = input;
  const target = input.budget - (input.safety ?? PLANNER_SAFETY_TOKENS);
  const trimmed: string[] = [];

  let system = input.system;
  let tools = [...input.tools];
  let toolIndex = [...input.toolIndex];
  let systemTokens = countTokens(buildToolSystemPrompt(system, tools, toolIndex));

  // 1. History or tool results get what the system prompt leaves.
  let userPrompt = query;
  let historyTokens = 0;
  let resultsTokens = 0;
  if (input.history && input.history.length > 0) {
    const room = target - systemTokens - CHAT_TEMPLATE_TOKENS;
    const { text, droppedEntries } = buildBudgetedHistoryContext({
      entries: input.history,
      currentMessage: query,
      countTokens,
      maxTokens: room,
    });
    userPrompt = text;
    historyTokens = Math.max(0, countTokens(text) - countTokens(query));
    if (droppedEntries > 0) trimmed.push(`history: dropped ${droppedEntries} of ${input.history.length} entries`);
  } else if (input.results) {
    const blocks = [...input.results.blocks];
    const render = () => input.results!.render(blocks.join('\n\n'));
    userPrompt = render();
    let cleared = 0;
    while (systemTokens + countTokens(userPrompt) + CHAT_TEMPLATE_TOKENS > target && cleared < blocks.length) {
      blocks[cleared] = `[Tool result #${cleared + 1} cleared from context]`;
      cleared++;
      userPrompt = render();
    }
    resultsTokens = Math.max(0, countTokens(userPrompt) - countTokens(input.results.render('')));
    if (cleared > 0) trimmed.push(`results: cleared the oldest ${cleared} of ${blocks.length}`);
  }

  const userTokens = countTokens(userPrompt);
  const total = () => systemTokens + userTokens + CHAT_TEMPLATE_TOKENS;

  // 2. Unused tools, lowest priority (last) first.
  for (let i = tools.length - 1; i >= 0 && total() > target; i--) {
    const tool = tools[i];
    if (input.protectedTools.has(tool.name)) continue;
    tools = tools.filter((t) => t !== tool);
    toolIndex = [tool.name, ...toolIndex];
    systemTokens = countTokens(buildToolSystemPrompt(system, tools, toolIndex));
    trimmed.push(`tools: dropped ${tool.name}`);
  }

  // 3. Skill descriptions down to names.
  if (total() > target && input.compactSystem !== undefined && input.compactSystem !== system) {
    system = input.compactSystem;
    systemTokens = countTokens(buildToolSystemPrompt(system, tools, toolIndex));
    trimmed.push('skills: names only');
  }

  if (input.hardLimit && total() > input.budget) {
    throw new LocalPromptTooLargeError(input.model.replace(/^transformers:/, ''), total(), input.budget);
  }

  const fixed = countTokens(system);
  return {
    systemPrompt: system,
    tools,
    toolIndex,
    userPrompt,
    tokens: {
      fixed,
      tools: systemTokens - fixed,
      history: historyTokens,
      results: resultsTokens,
      template: CHAT_TEMPLATE_TOKENS,
      total: total(),
      budget: input.budget,
    },
    trimmed,
  };
}
