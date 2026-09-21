import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { z } from 'zod';
import { ensureTestProfile } from './helpers.js';
import type { LlmResponse, ProviderAdapter } from '../model/types.js';
import { LlmValidationError } from '../model/structured-output.js';

// --- Mocks for callLlm's dependencies ---

let mockAdapterFn: (...args: any[]) => Promise<LlmResponse>;

// Re-mock providers/index.js (may have been mocked by agent.test.ts)
mock.module('../model/providers/index.js', () => ({
  getAdapter: mock((): ProviderAdapter => ({
    call: async (...args: any[]) => mockAdapterFn(...args),
  })),
}));

// NOTE: Do NOT mock trace-store.js or interaction-store.js here.
// They are harmless in-memory stores, and mocking them globally would
// poison dashboard-api.test.ts and interaction-store.test.ts.

const { callLlm, getFastModel } = await import('../model/llm.js');

function makeLlmResponse(overrides: Partial<LlmResponse> = {}): LlmResponse {
  return {
    content: 'test response',
    toolCalls: [],
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    ...overrides,
  };
}

describe('callLlm', () => {
  beforeEach(() => {
    ensureTestProfile();
    // Reset the adapter to a default success response
    mockAdapterFn = async () => makeLlmResponse();
  });

  test('success returns response, usage, and interactionId', async () => {
    mockAdapterFn = async () => makeLlmResponse({ content: 'Hello!' });

    const result = await callLlm('test prompt');
    expect(result.response.content).toBe('Hello!');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    // interactionId is null when no DB is set on the singleton interactionStore
    expect(result).toHaveProperty('interactionId');
  });

  test('success with tool calls', async () => {
    mockAdapterFn = async () => makeLlmResponse({
      content: '',
      toolCalls: [{ id: 'tc1', name: 'spending_summary', args: { month: '2026-02' } }],
    });

    const result = await callLlm('show spending', { tools: [] });
    expect(result.response.toolCalls).toHaveLength(1);
    expect(result.response.toolCalls[0].name).toBe('spending_summary');
  });

  test('retries on retryable error', async () => {
    let callCount = 0;
    mockAdapterFn = async () => {
      callCount++;
      if (callCount === 1) throw new Error('rate limit exceeded');
      return makeLlmResponse({ content: 'retry success' });
    };

    const result = await callLlm('test', { model: 'gpt-5.2' });
    expect(result.response.content).toBe('retry success');
    expect(callCount).toBe(2);
  });

  test('non-retryable error throws immediately', async () => {
    mockAdapterFn = async () => {
      throw new Error('invalid api key');
    };

    await expect(callLlm('test', { model: 'gpt-5.2' })).rejects.toThrow('invalid api key');
  });

  test('max retries exceeded throws', async () => {
    mockAdapterFn = async () => {
      throw new Error('service unavailable');
    };

    await expect(callLlm('test', { model: 'gpt-5.2' })).rejects.toThrow('service unavailable');
  });

  test('strips openrouter prefix from model name', async () => {
    let receivedModel = '';
    mockAdapterFn = async (opts: any) => {
      receivedModel = opts.model;
      return makeLlmResponse();
    };

    await callLlm('test', { model: 'openrouter:openai/gpt-4o-mini' });
    expect(receivedModel).toBe('openai/gpt-4o-mini');
  });

  test('strips ollama prefix from model name', async () => {
    let receivedModel = '';
    mockAdapterFn = async (opts: any) => {
      receivedModel = opts.model;
      return makeLlmResponse();
    };

    await callLlm('test', { model: 'ollama:llama3' });
    expect(receivedModel).toBe('llama3');
  });

  test('strips openai-compatible prefix from model name', async () => {
    let receivedModel = '';
    mockAdapterFn = async (opts: any) => {
      receivedModel = opts.model;
      return makeLlmResponse();
    };

    await callLlm('test', { model: 'openai-compatible:Qwen/Qwen3-8B' });
    expect(receivedModel).toBe('Qwen/Qwen3-8B');
  });

  test('keeps dash-prefixed model names intact', async () => {
    let receivedModel = '';
    mockAdapterFn = async (opts: any) => {
      receivedModel = opts.model;
      return makeLlmResponse();
    };

    await callLlm('test', { model: 'claude-sonnet-4-6' });
    expect(receivedModel).toBe('claude-sonnet-4-6');
  });
});

describe('callLlm structured-output validation', () => {
  const testSchema = z.object({
    items: z.array(z.object({ id: z.number(), confidence: z.number().min(0).max(1) })),
  });

  // Mirrors the tightened categorization schema: confidence must be a number in [0, 1].
  const categorizationSchema = z.object({
    transactions: z.array(
      z.object({ id: z.number(), category: z.string(), confidence: z.number().min(0).max(1) }),
    ),
  });

  beforeEach(() => {
    ensureTestProfile();
    mockAdapterFn = async () => makeLlmResponse();
  });

  test('valid structured output passes through unchanged with a single adapter call', async () => {
    let adapterCalls = 0;
    const valid = { items: [{ id: 1, confidence: 0.9 }] };
    mockAdapterFn = async () => {
      adapterCalls++;
      return makeLlmResponse({ content: JSON.stringify(valid), structured: valid });
    };

    const result = await callLlm('test prompt', { outputSchema: testSchema });
    expect(adapterCalls).toBe(1);
    expect(result.response.structured).toEqual(valid);
    expect(result.response.content).toBe(JSON.stringify(valid));
  });

  test('structured missing but content parses to schema-valid JSON is validated and populated', async () => {
    let adapterCalls = 0;
    mockAdapterFn = async () => {
      adapterCalls++;
      return makeLlmResponse({ content: '{"items":[{"id":2,"confidence":0.5}]}' });
    };

    const result = await callLlm('test prompt', { outputSchema: testSchema });
    expect(adapterCalls).toBe(1); // no repair needed
    expect(result.response.structured).toEqual({ items: [{ id: 2, confidence: 0.5 }] });
  });

  test('malformed structured output triggers one schema-aware repair prompt that succeeds', async () => {
    const calls: any[] = [];
    mockAdapterFn = async (opts: any) => {
      calls.push(opts);
      if (calls.length === 1) {
        return makeLlmResponse({ content: 'not json', structured: { items: 'nope' } });
      }
      return makeLlmResponse({
        content: '{"items":[{"id":3,"confidence":1}]}',
        structured: { items: [{ id: 3, confidence: 1 }] },
      });
    };

    const result = await callLlm('categorize my transactions', { outputSchema: testSchema });

    expect(calls.length).toBe(2); // original + exactly one repair
    // The repair re-prompt contains the original task, the validation issue, and the JSON schema.
    expect(calls[1].userPrompt).toContain('categorize my transactions');
    expect(calls[1].userPrompt).toContain('Validation issues');
    expect(calls[1].userPrompt).toContain('items'); // issue path
    expect(calls[1].userPrompt).toContain('"type": "object"'); // schema text
    expect(calls[1].userPrompt).toContain('"minimum": 0');
    expect(calls[1].userPrompt).toContain('ONLY a single JSON object');
    // Repair succeeded and the validated value is returned.
    expect(result.response.structured).toEqual({ items: [{ id: 3, confidence: 1 }] });
  });

  test('malformed structured output on both attempts rejects with LlmValidationError', async () => {
    let adapterCalls = 0;
    mockAdapterFn = async () => {
      adapterCalls++;
      return makeLlmResponse({ content: 'garbage', structured: { wrong: 'shape' } });
    };

    try {
      await callLlm('test prompt', { outputSchema: testSchema });
      expect.unreachable('callLlm should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmValidationError);
      expect((err as LlmValidationError).name).toBe('LlmValidationError');
      expect((err as LlmValidationError).issues.length).toBeGreaterThan(0);
      expect((err as LlmValidationError).lastResponse.content).toBe('garbage');
      expect(String(err)).toContain('failed schema validation after one repair attempt');
    }
    expect(adapterCalls).toBe(2); // original + exactly one repair, never a third
  });

  test('string confidence against the tightened tool schema triggers repair then rejection', async () => {
    let adapterCalls = 0;
    const badConfidence = { transactions: [{ id: 1, category: 'Shopping', confidence: '0.9' }] };
    mockAdapterFn = async () => {
      adapterCalls++;
      return makeLlmResponse({ content: JSON.stringify(badConfidence), structured: badConfidence });
    };

    await expect(
      callLlm('test prompt', { outputSchema: categorizationSchema }),
    ).rejects.toThrow('failed schema validation after one repair attempt');
    expect(adapterCalls).toBe(2);
  });

  test('out-of-range confidence (1.5) violates the tightened tool schema and is rejected', async () => {
    let adapterCalls = 0;
    const badConfidence = { transactions: [{ id: 1, category: 'Shopping', confidence: 1.5 }] };
    mockAdapterFn = async () => {
      adapterCalls++;
      return makeLlmResponse({ content: JSON.stringify(badConfidence), structured: badConfidence });
    };

    try {
      await callLlm('test prompt', { outputSchema: categorizationSchema });
      expect.unreachable('callLlm should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmValidationError);
      expect((err as LlmValidationError).issues.join('; ')).toContain('confidence');
    }
    expect(adapterCalls).toBe(2);
  });

  test('repair attempt that returns schema-valid content JSON is accepted', async () => {
    const calls: any[] = [];
    mockAdapterFn = async (opts: any) => {
      calls.push(opts);
      if (calls.length === 1) {
        // structured present but garbage; repair responds with plain content JSON
        return makeLlmResponse({ content: 'broken', structured: { nope: true } });
      }
      return makeLlmResponse({ content: '{"items":[{"id":9,"confidence":0.25}]}' });
    };

    const result = await callLlm('test prompt', { outputSchema: testSchema });
    expect(calls.length).toBe(2);
    expect(result.response.structured).toEqual({ items: [{ id: 9, confidence: 0.25 }] });
  });
});

describe('getFastModel', () => {
  test('returns provider fast model when available', () => {
    expect(getFastModel('openai', 'gpt-5.2')).toBe('gpt-4.1');
  });

  test('returns fallback for unknown provider', () => {
    expect(getFastModel('nonexistent', 'my-model')).toBe('my-model');
  });
});
