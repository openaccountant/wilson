import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { planLocalPrompt, PLANNER_SAFETY_TOKENS, type LocalPromptInput } from '../agent/local-prompt-planner.js';
import { buildToolSystemPrompt, LocalPromptTooLargeError } from '../model/providers/transformers.js';
import { CURRENT_MESSAGE_MARKER, type HistoryEntry } from '../utils/history-context.js';
import type { ToolDef } from '../model/types.js';

// Fake tokenizer: one token per 4 characters.
const countTokens = (text: string) => Math.ceil(text.length / 4);

const BUDGET = 8192;
const MODEL = 'onnx-community/granite-4.0-micro-ONNX-web';

function fakeTool(name: string, words: number): ToolDef {
  return {
    name,
    description: `${name} ${'word '.repeat(words)}`.trim(),
    schema: z.object({ q: z.string().optional() }),
    func: async () => '',
  } as unknown as ToolDef;
}

const TOOLS = [
  fakeTool('transaction_search', 20),
  fakeTool('spending_summary', 20),
  fakeTool('goal_manage', 300),
  fakeTool('tax_flag', 300),
  fakeTool('memory_manage', 300),
];
const CORE = new Set(['transaction_search', 'spending_summary']);

const LONG_CONTEXTS = `\n\n## Memory\n\n${'- [fact] the user is self-employed\n'.repeat(60)}`;
const SYSTEM = `You are Open Accountant.${LONG_CONTEXTS}\n\n## Available Skills\n\n- **tax-prep**: ${'prep '.repeat(400)}`;
const COMPACT_SYSTEM = `You are Open Accountant.${LONG_CONTEXTS}\n\n## Available Skills\n\ntax-prep`;

function history(turns: number): HistoryEntry[] {
  return Array.from({ length: turns }, (_, i) => [
    { role: 'user' as const, content: `question ${i}: ${'q'.repeat(200)}` },
    { role: 'assistant' as const, content: `answer ${i}: ${'a'.repeat(1500)}` },
  ]).flat();
}

function results(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `### transaction_search(q=${i})\n${'r'.repeat(6000)}`);
}

function base(overrides: Partial<LocalPromptInput> = {}): LocalPromptInput {
  return {
    model: MODEL,
    budget: BUDGET,
    hardLimit: true,
    countTokens,
    system: SYSTEM,
    compactSystem: COMPACT_SYSTEM,
    tools: TOOLS,
    protectedTools: CORE,
    toolIndex: ['plaid_sync'],
    query: 'how much did I spend on dining?',
    ...overrides,
  };
}

/** Tokens of the prompt the adapter will assemble from the plan. */
function assembled(plan: ReturnType<typeof planLocalPrompt>): number {
  return (
    countTokens(buildToolSystemPrompt(plan.systemPrompt, plan.tools, plan.toolIndex)) + countTokens(plan.userPrompt)
  );
}

describe('planLocalPrompt', () => {
  test('a small prompt goes through untouched', () => {
    const plan = planLocalPrompt(base({ history: history(1) }));
    expect(plan.trimmed).toEqual([]);
    expect(plan.systemPrompt).toBe(SYSTEM);
    expect(plan.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(plan.userPrompt).toContain('answer 0');
    expect(plan.userPrompt).toContain(CURRENT_MESSAGE_MARKER);
    expect(plan.tokens.budget).toBe(BUDGET);
    expect(plan.tokens.total).toBe(assembled(plan) + plan.tokens.template);
  });

  test('20 turns of history are trimmed oldest first to fit budget − safety; tools are kept', () => {
    const plan = planLocalPrompt(base({ history: history(20) }));
    expect(assembled(plan)).toBeLessThanOrEqual(BUDGET - PLANNER_SAFETY_TOKENS);
    expect(plan.userPrompt).toContain('answer 19');
    expect(plan.userPrompt).not.toContain('question 0:');
    expect(plan.trimmed[0]).toMatch(/^history:/);
    expect(plan.tools).toHaveLength(TOOLS.length);
    expect(plan.systemPrompt).toBe(SYSTEM);
  });

  test('6 large tool results: oldest are cleared first, newest kept', () => {
    const render = (joined: string) => `Query: q\n\nData retrieved from tool calls:\n${joined}\n\nContinue.`;
    const plan = planLocalPrompt(base({ results: { blocks: results(6), render } }));
    expect(assembled(plan)).toBeLessThanOrEqual(BUDGET - PLANNER_SAFETY_TOKENS);
    expect(plan.userPrompt).toContain('[Tool result #1 cleared from context]');
    expect(plan.userPrompt).toContain('transaction_search(q=5)');
    expect(plan.trimmed[0]).toMatch(/^results:/);
    expect(plan.tools).toHaveLength(TOOLS.length);
  });

  test('then unused tools are dropped (lowest priority first) and indexed by name, never protected ones', () => {
    // A huge system prompt leaves no room for all schemas.
    const system = `S ${'x'.repeat(4 * 6850)}`;
    const plan = planLocalPrompt(base({ system, compactSystem: undefined, history: history(5) }));
    expect(assembled(plan)).toBeLessThanOrEqual(BUDGET - PLANNER_SAFETY_TOKENS);
    const names = plan.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([...CORE]));
    expect(names).not.toContain('memory_manage');
    expect(plan.toolIndex).toContain('memory_manage');
    expect(plan.toolIndex).toContain('plaid_sync');
    const order = plan.trimmed.map((t) => t.split(':')[0]);
    expect(order.indexOf('history')).toBeLessThan(order.indexOf('tools'));
  });

  test('last, skill descriptions are reduced to names', () => {
    const system = `${SYSTEM} ${'y'.repeat(4 * 6900)}`;
    const compact = `${COMPACT_SYSTEM} ${'y'.repeat(4 * 6900)}`;
    const plan = planLocalPrompt(base({ system, compactSystem: compact, history: history(3) }));
    expect(plan.systemPrompt).toBe(compact);
    expect(plan.trimmed.at(-1)).toMatch(/^skills:/);
    expect(assembled(plan)).toBeLessThanOrEqual(BUDGET - PLANNER_SAFETY_TOKENS);
  });

  test('a query that alone exceeds the budget still raises LocalPromptTooLargeError', () => {
    const query = 'z'.repeat(4 * 9000);
    expect(() => planLocalPrompt(base({ query, history: history(3) }))).toThrow(LocalPromptTooLargeError);
  });

  test('a soft (CPU) budget trims the same way but never throws', () => {
    const query = 'z'.repeat(4 * 13000);
    const plan = planLocalPrompt(base({ query, budget: 12_000, hardLimit: false, history: history(3) }));
    expect(plan.userPrompt).toBe(query);
    expect(plan.tokens.total).toBeGreaterThan(12_000);
  });
});
