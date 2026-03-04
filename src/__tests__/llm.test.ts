import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { ensureTestProfile } from './helpers.js';
import type { LlmResponse, ProviderAdapter } from '../model/types.js';

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
});

describe('getFastModel', () => {
  test('returns provider fast model when available', () => {
    expect(getFastModel('openai', 'gpt-5.2')).toBe('gpt-4.1');
  });

  test('returns fallback for unknown provider', () => {
    expect(getFastModel('nonexistent', 'my-model')).toBe('my-model');
  });
});
