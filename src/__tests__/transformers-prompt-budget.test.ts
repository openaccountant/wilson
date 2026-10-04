import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  buildToolSystemPrompt,
  explainGenerationError,
  localPromptBudget,
  LocalPromptTooLargeError,
  assertWithinPromptBudget,
  callableToolNames,
  compactToolSchema,
  estimateTokens as estimateLocalTokens,
  parseToolCall,
  TOOL_INDEX_MAX_NAMES,
} from '../model/providers/transformers.js';
import { formatUserFacingError } from '../utils/errors.js';
import type { ToolDef } from '../model/types.js';

const GRANITE = 'onnx-community/granite-4.0-micro-ONNX-web';

const tool = {
  name: 'categorize',
  description: 'Categorize uncategorized transactions.',
  schema: z.object({ limit: z.number().optional().describe('Max transactions') }),
} as unknown as ToolDef;

describe('local model prompt budget', () => {
  test('WebGPU models get a budget; CPU models do not', () => {
    // Measured: granite-4.0-micro q4f16 on WebGPU ran 8k-token prompts and
    // failed with "Unknown failure" at 12k and 17k.
    expect(localPromptBudget(GRANITE)).toBe(8192);
    expect(localPromptBudget('HuggingFaceTB/SmolLM3-3B-ONNX')).toBeNull();
  });

  test('an over-budget prompt fails fast with a clear, non-retryable reason', () => {
    expect(() => assertWithinPromptBudget(GRANITE, 7000)).not.toThrow();
    let err: unknown;
    try {
      assertWithinPromptBudget(GRANITE, 17337);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LocalPromptTooLargeError);
    const msg = (err as Error).message;
    expect(msg).toContain('17337');
    expect(msg).toContain('8192');
    expect(msg).toContain(GRANITE);
    // Reaches the chat verbatim (not a generic category, not truncated).
    const shown = formatUserFacingError(`[Transformers.js (local) API] ${msg}`);
    expect(shown).toContain(msg);
  });

  test('"Unknown failure" from ONNX Runtime is explained with the prompt size', () => {
    const err = explainGenerationError(GRANITE, 'webgpu', 9000, new Error('Unknown failure'));
    expect(err.message).toContain('Unknown failure');
    expect(err.message).toContain('9000-token prompt');
    expect(err.message).toContain(GRANITE);
    expect(formatUserFacingError(`[Transformers.js (local) API] ${err.message}`)).toContain(err.message);
  });
});

describe('tool prompt for local models', () => {
  test('schemas are compact JSON without JSON-Schema boilerplate', () => {
    const prompt = buildToolSystemPrompt('SYS', [tool]);
    expect(prompt.startsWith('SYS')).toBe(true);
    expect(prompt).toContain('"name":"categorize"');
    expect(prompt).toContain('<tool_call>');
    expect(prompt).not.toContain('$schema');
    expect(prompt).not.toContain('additionalProperties');
    expect(prompt).not.toContain('\n  ');
  });

  test('no tools leaves the system prompt untouched', () => {
    expect(buildToolSystemPrompt('SYS', [])).toBe('SYS');
  });

  test('without an index the prompt is unchanged (no index line)', () => {
    expect(buildToolSystemPrompt('SYS', [tool], [])).toBe(buildToolSystemPrompt('SYS', [tool]));
    expect(buildToolSystemPrompt('SYS', [tool])).not.toContain('Other tools');
  });

  test('tools left out of the subset are listed by name after the schemas', () => {
    const prompt = buildToolSystemPrompt('SYS', [tool], ['plaid_sync', 'goal_manage']);
    expect(prompt).toContain(
      'Other tools (not shown; call by name and the schema is returned): plaid_sync, goal_manage',
    );
    expect(prompt.indexOf('Other tools')).toBeGreaterThan(prompt.indexOf('"name":"categorize"'));
    expect(prompt).not.toContain('"name":"plaid_sync"');
  });

  test('a long index is capped', () => {
    const many = Array.from({ length: TOOL_INDEX_MAX_NAMES + 5 }, (_, i) => `mcp_tool_${i}`);
    const prompt = buildToolSystemPrompt('SYS', [tool], many);
    expect(prompt).toContain(`mcp_tool_${TOOL_INDEX_MAX_NAMES - 1}`);
    expect(prompt).not.toContain(`mcp_tool_${TOOL_INDEX_MAX_NAMES},`);
    expect(prompt).toContain('… and 5 more');
  });

  test('compactToolSchema is the per-tool JSON the prompt injects', () => {
    const compact = compactToolSchema(tool);
    expect(compact.name).toBe('categorize');
    expect(JSON.stringify(compact)).not.toContain('$schema');
    expect(buildToolSystemPrompt('SYS', [tool])).toContain(JSON.stringify([compact]));
  });

  test('the char-based token estimate is ~chars/3.2', () => {
    expect(estimateLocalTokens('x'.repeat(320))).toBe(100);
    expect(estimateLocalTokens('')).toBe(0);
  });
});

describe('tool-call parsing for local models', () => {
  const names = ['transaction_search', 'categorize'];

  test('the documented <tool_call> format', () => {
    const call = parseToolCall('<tool_call>{"name": "categorize", "arguments": {"limit": 5}}</tool_call>', names);
    expect(call?.name).toBe('categorize');
    expect(call?.args).toEqual({ limit: 5 });
  });

  test('bare JSON with stringified arguments and a stray fence (granite-4.0-micro, observed)', () => {
    const raw = '{"name": "transaction_search", "arguments": "{\\n  \\"query\\": \\"dining in September 2026\\"\\n}"}\n```';
    const call = parseToolCall(raw, names);
    expect(call?.name).toBe('transaction_search');
    expect(call?.args).toEqual({ query: 'dining in September 2026' });
  });

  test('fenced JSON', () => {
    const call = parseToolCall('```json\n{"name": "categorize", "arguments": {}}\n```', names);
    expect(call?.name).toBe('categorize');
  });

  test('a bare call followed by an invented answer is still the call (granite, 6 of 24 lost)', () => {
    const raw =
      '{"name": "spending_summary", "arguments": "{\\"period\\": \\"July\\"}"}\n\n**Groceries spending in July:** $842.50 (22% of total) {braces}';
    const call = parseToolCall(raw, ['spending_summary', ...names]);
    expect(call?.name).toBe('spending_summary');
    expect(call?.args).toEqual({ period: 'July' });
  });

  test('braces and escaped quotes inside string values do not end the object early', () => {
    const raw = '{"name": "categorize", "arguments": {"note": "a } \\" { b"}} trailing';
    expect(parseToolCall(raw, names)?.args).toEqual({ note: 'a } " { b' });
  });

  test('a truncated call stays text', () => {
    expect(parseToolCall('{"name": "categorize", "arguments": {"limit": ', names)).toBeNull();
  });

  test('a skill name called as a tool becomes a skill call (granite, observed)', () => {
    const skills = ['month-end-close'];
    const withSkill = [...names, 'skill'];
    const bare = parseToolCall('{"name": "month-end-close", "arguments": {}} Sure, closing...', withSkill, skills);
    expect(bare?.name).toBe('skill');
    expect(bare?.args).toEqual({ skill: 'month-end-close' });

    const withArgs = parseToolCall('{"name": "month-end-close", "arguments": {"month": "2026-09"}}', withSkill, skills);
    expect(withArgs?.args).toEqual({ skill: 'month-end-close', args: '{"month":"2026-09"}' });

    const tagged = parseToolCall('<tool_call>{"name": "month-end-close", "arguments": {}}</tool_call>', withSkill, skills);
    expect(tagged?.name).toBe('skill');
  });

  test('a real tool wins over a same-named skill; unknown names stay rejected', () => {
    expect(parseToolCall('{"name": "categorize", "arguments": {}}', names, ['categorize'])?.name).toBe('categorize');
    expect(parseToolCall('{"name": "nope", "arguments": {}}', names, ['month-end-close'])).toBeNull();
  });

  test('a bare call to an indexed (schema not shown) tool parses', () => {
    const callable = callableToolNames([tool], ['plaid_sync']);
    expect(callable).toEqual(['categorize', 'plaid_sync']);
    expect(parseToolCall('{"name": "plaid_sync", "arguments": {}}', callable)?.name).toBe('plaid_sync');
    expect(callableToolNames([tool])).toEqual(['categorize']);
  });

  test('plain answers and JSON naming an unknown tool stay text', () => {
    expect(parseToolCall('You spent $42 on dining.', names)).toBeNull();
    expect(parseToolCall('{"name": "rm_rf", "arguments": {}}', names)).toBeNull();
    expect(parseToolCall('{"total": 42}', names)).toBeNull();
  });
});
