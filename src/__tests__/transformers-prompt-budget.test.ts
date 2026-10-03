import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  buildToolSystemPrompt,
  explainGenerationError,
  localPromptBudget,
  LocalPromptTooLargeError,
  assertWithinPromptBudget,
  parseToolCall,
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

  test('plain answers and JSON naming an unknown tool stay text', () => {
    expect(parseToolCall('You spent $42 on dining.', names)).toBeNull();
    expect(parseToolCall('{"name": "rm_rf", "arguments": {}}', names)).toBeNull();
    expect(parseToolCall('{"total": 42}', names)).toBeNull();
  });
});
