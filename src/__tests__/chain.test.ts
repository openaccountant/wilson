import { describe, expect, test, beforeEach, afterAll, mock } from 'bun:test';
import { z } from 'zod';
import { ensureTestProfile } from './helpers.js';
import { defineTool } from '../tools/define-tool.js';
import type { LlmResponse, ProviderAdapter } from '../model/types.js';
import type { ChainDef } from '../orchestration/types.js';

// --- Mocks: control the adapter, not callLlm ---

let adapterCallCount = 0;
let adapterResponses: LlmResponse[] = [];
/** userPrompt of every adapter call, in order (for asserting feedback prompts). */
let receivedPrompts: string[] = [];

const mockAdapterCall = mock(async (options?: { userPrompt?: string }): Promise<LlmResponse> => {
  if (options?.userPrompt !== undefined) receivedPrompts.push(options.userPrompt);
  const response = adapterResponses[Math.min(adapterCallCount, adapterResponses.length - 1)];
  adapterCallCount++;
  return response;
});

mock.module('../model/providers/index.js', () => ({
  getAdapter: mock((): ProviderAdapter => ({ call: mockAdapterCall })),
}));

// NOTE: Do NOT mock trace-store.js or interaction-store.js here.
// They are harmless in-memory stores, and mocking them globally would
// poison dashboard-api.test.ts and interaction-store.test.ts.

// Capture real functions BEFORE mock.module (bun mutates the module object in-place).
// When mockToolsByNames is empty (default), falls through to the real implementation
// so tool-registry.test.ts still works correctly.
const {
  getToolRegistry: realGetToolRegistry,
  getTools: realGetTools,
  getToolsByNames: realGetToolsByNames,
  buildToolDescriptions: realBuildToolDescriptions,
} = await import('../tools/registry.js');
let mockToolsByNames: any[] = [];

mock.module('../tools/registry.js', () => ({
  getToolRegistry: realGetToolRegistry,
  getTools: realGetTools,
  getToolsByNames: mock(async (names: string[]) => {
    if (mockToolsByNames.length > 0) return mockToolsByNames;
    return realGetToolsByNames(names);
  }),
  buildToolDescriptions: realBuildToolDescriptions,
}));

const { runChain } = await import('../orchestration/chain.js');

afterAll(() => {
  // bun shares module mocks across test files: leaving mockToolsByNames
  // populated would make later files (e.g. tool-registry.test.ts) receive
  // this file's leftover fake tools instead of the real registry.
  mockToolsByNames = [];
});

function makeResponse(content: string, toolCalls: LlmResponse['toolCalls'] = []): LlmResponse {
  return { content, toolCalls, usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 } };
}

describe('runChain', () => {
  beforeEach(() => {
    ensureTestProfile();
    adapterResponses = [];
    adapterCallCount = 0;
    mockToolsByNames = [];
    receivedPrompts = [];
    mockAdapterCall.mockReset();
    mockAdapterCall.mockImplementation(async (options?: { userPrompt?: string }) => {
      if (options?.userPrompt !== undefined) receivedPrompts.push(options.userPrompt);
      const response = adapterResponses[Math.min(adapterCallCount, adapterResponses.length - 1)];
      adapterCallCount++;
      return response;
    });
  });

  test('single step no tools returns LLM content', async () => {
    const chain: ChainDef = {
      name: 'test-chain',
      description: 'Test',
      steps: [{ id: 'step1' }],
    };

    adapterResponses = [makeResponse('Analysis complete: spending is $500.')];

    const result = await runChain(chain, 'What is my spending?');
    expect(result).toBe('Analysis complete: spending is $500.');
  });

  test('multi-step chains output through steps', async () => {
    const chain: ChainDef = {
      name: 'two-step',
      description: 'Two step chain',
      steps: [{ id: 'gather' }, { id: 'summarize' }],
    };

    adapterResponses = [
      makeResponse('Raw data: groceries $200, dining $100'),
      makeResponse('Summary: You spent $300 total on food.'),
    ];

    const result = await runChain(chain, 'Analyze food spending');
    expect(result).toBe('Summary: You spent $300 total on food.');
  });

  test('step with tool calls executes tools then gets final response', async () => {
    let toolCalled = false;
    mockToolsByNames = [{
      name: 'spending_summary',
      description: 'Spending summary',
      schema: {} as any,
      func: async () => { toolCalled = true; return '{"total": 500}'; },
    }];

    const chain: ChainDef = {
      name: 'tool-chain',
      description: 'Chain with tools',
      steps: [{ id: 'analyze', tools: ['spending_summary'] }],
    };

    adapterResponses = [
      makeResponse('', [{ id: 'tc1', name: 'spending_summary', args: { month: '2026-02' } }]),
      makeResponse('Total spending is $500.'),
    ];

    const result = await runChain(chain, 'How much did I spend?');
    expect(toolCalled).toBe(true);
    expect(result).toBe('Total spending is $500.');
  });

  test('max iterations forces final response', async () => {
    mockToolsByNames = [{
      name: 'test',
      description: 'Test',
      schema: {} as any,
      func: async () => 'test result',
    }];

    const chain: ChainDef = {
      name: 'loop-chain',
      description: 'Chain that loops',
      steps: [{ id: 'looper', maxIterations: 2, tools: ['test'] }],
    };

    adapterResponses = [
      makeResponse('', [{ id: 'tc1', name: 'test', args: {} }]),
      makeResponse('', [{ id: 'tc2', name: 'test', args: {} }]),
      makeResponse('Forced final answer.'),
    ];

    const result = await runChain(chain, 'Loop test');
    expect(result).toBe('Forced final answer.');
  });

  test('onStepComplete callback is called for each step', async () => {
    const chain: ChainDef = {
      name: 'callback-chain',
      description: 'Test callbacks',
      steps: [{ id: 'step-a' }, { id: 'step-b' }],
    };

    adapterResponses = [
      makeResponse('Output A'),
      makeResponse('Output B'),
    ];

    const completed: Array<{ stepId: string; output: string }> = [];
    await runChain(chain, 'test', {
      onStepComplete: (stepId, output) => completed.push({ stepId, output }),
    });

    expect(completed).toHaveLength(2);
    expect(completed[0]).toEqual({ stepId: 'step-a', output: 'Output A' });
    expect(completed[1]).toEqual({ stepId: 'step-b', output: 'Output B' });
  });

  test('step system prompt is forwarded', async () => {
    const chain: ChainDef = {
      name: 'prompt-chain',
      description: 'Test system prompt',
      steps: [{ id: 'step1', systemPrompt: 'You are a tax expert.' }],
    };

    adapterResponses = [makeResponse('Tax analysis done.')];

    const result = await runChain(chain, 'Do my taxes');
    expect(result).toBe('Tax analysis done.');
    expect(mockAdapterCall).toHaveBeenCalled();
  });

  test('malformed tool args are rejected by the schema guard and fed back to the step model', async () => {
    let funcCalls = 0;
    // Real defineTool guard applies (define-tool.js is NOT mocked here)
    mockToolsByNames = [defineTool({
      name: 'edit_transaction',
      description: 'Edit a transaction',
      schema: z.object({ id: z.number() }),
      func: async () => { funcCalls++; return 'edited'; },
    })];

    const chain: ChainDef = {
      name: 'guarded-chain',
      description: 'Chain with guarded tool',
      steps: [{ id: 'edit', tools: ['edit_transaction'] }],
    };

    adapterResponses = [
      makeResponse('', [{ id: 'tc1', name: 'edit_transaction', args: { id: 'abc' } }]),
      makeResponse('Could not edit: invalid arguments.'),
    ];

    const result = await runChain(chain, 'Edit transaction abc');
    expect(funcCalls).toBe(0); // record never touched by garbage args
    expect(result).toBe('Could not edit: invalid arguments.');

    // The second iteration prompt carries the validation error back to the model
    expect(receivedPrompts.length).toBe(2);
    expect(receivedPrompts[1]).toContain("Invalid arguments for tool 'edit_transaction'");
    expect(receivedPrompts[1]).toContain('id'); // offending field named
  });
});
