import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { ensureTestProfile, collectEvents, mockTool } from './helpers.js';
import type { LlmResponse, ProviderAdapter } from '../model/types.js';

// --- Mocks: only mock leaf dependencies, NOT callLlm or registry ---

// Mock the adapter to control LLM responses
let adapterCallCount = 0;
let adapterResponses: LlmResponse[] = [];

const mockAdapterCall = mock(async (): Promise<LlmResponse> => {
  const response = adapterResponses[Math.min(adapterCallCount, adapterResponses.length - 1)];
  adapterCallCount++;
  return response;
});

mock.module('../model/providers/index.js', () => ({
  getAdapter: mock((): ProviderAdapter => ({ call: mockAdapterCall })),
}));

// Mock prompts (reads filesystem)
mock.module('../agent/prompts.js', () => ({
  buildSystemPrompt: mock(async () => 'You are a financial assistant.'),
  buildIterationPrompt: mock((_q: string, _results: string, _usage: string | null) => 'iteration prompt'),
  loadSoulDocument: mock(async () => ''),
  buildBudgetContext: mock(() => null),
  buildDataContext: mock(() => null),
  buildProfileContext: mock(() => null),
  buildGoalContext: mock(() => null),
  buildMemoryContext: mock(() => null),
  buildCustomPromptContext: mock(() => null),
  DEFAULT_SYSTEM_PROMPT: 'You are a financial assistant.',
}));

// NOTE: Do NOT mock trace-store.js or interaction-store.js here.
// They are harmless in-memory stores, and mocking them globally would
// poison dashboard-api.test.ts and interaction-store.test.ts.

// Mock MCP adapter (used by registry)
mock.module('../mcp/adapter.js', () => ({
  getCachedMcpTools: mock(() => []),
}));

// Mock orchestration registry (used by tool registry)
mock.module('../orchestration/registry.js', () => ({
  getOrchestrationTools: mock(async () => []),
}));

// Mock skill discovery (used by tool registry)
mock.module('../skills/index.js', () => ({
  discoverSkills: mock(() => []),
  getSkill: mock(async () => null),
  buildSkillMetadataSection: mock(() => ''),
  clearSkillCache: mock(() => {}),
  parseSkillFile: mock(() => null),
  loadSkillFromPath: mock(() => null),
  extractSkillMetadata: mock(() => null),
}));

const { Agent } = await import('../agent/agent.js');

function makeResponse(content: string, toolCalls: LlmResponse['toolCalls'] = []): LlmResponse {
  return {
    content,
    toolCalls,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  };
}

describe('Agent', () => {
  beforeEach(() => {
    ensureTestProfile();
    adapterResponses = [];
    adapterCallCount = 0;
    mockAdapterCall.mockReset();
    mockAdapterCall.mockImplementation(async () => {
      const response = adapterResponses[Math.min(adapterCallCount, adapterResponses.length - 1)];
      adapterCallCount++;
      return response;
    });
  });

  test('direct response (no tools called) yields done event', async () => {
    adapterResponses = [makeResponse('Your spending is $500.')];

    const agent = await Agent.create({ maxIterations: 5 });
    const events = await collectEvents(agent.run('How much did I spend?'));

    const doneEvent = events.find((e) => e.type === 'done')!;
    expect(doneEvent).toBeTruthy();
    expect((doneEvent as any).answer).toBe('Your spending is $500.');
    expect((doneEvent as any).iterations).toBe(1);
  });

  test('max iterations reached yields appropriate message', async () => {
    // Adapter always returns tool calls
    adapterResponses = [
      makeResponse('', [{ id: 'tc1', name: 'csv_import', args: {} }]),
    ];

    const agent = await Agent.create({ maxIterations: 2 });
    const events = await collectEvents(agent.run('infinite loop'));

    const doneEvent = events.find((e) => e.type === 'done')!;
    expect(doneEvent).toBeTruthy();
    expect((doneEvent as any).answer).toContain('maximum iterations');
    expect((doneEvent as any).iterations).toBe(2);
  });

  test('token usage is accumulated across iterations', async () => {
    adapterResponses = [
      makeResponse('', [{ id: 'tc1', name: 'csv_import', args: { filePath: '/tmp/test.csv' } }]),
      makeResponse('Done!'),
    ];

    const agent = await Agent.create({ maxIterations: 5 });
    const events = await collectEvents(agent.run('test'));

    const doneEvent = events.find((e) => e.type === 'done')!;
    expect((doneEvent as any).tokenUsage).toBeTruthy();
    expect((doneEvent as any).tokenUsage.totalTokens).toBeGreaterThan(0);
  });

  test('done event includes totalTime', async () => {
    adapterResponses = [makeResponse('Quick answer.')];

    const agent = await Agent.create({ maxIterations: 5 });
    const events = await collectEvents(agent.run('fast query'));

    const doneEvent = events.find((e) => e.type === 'done')!;
    expect((doneEvent as any).totalTime).toBeGreaterThanOrEqual(0);
  });

  test('LLM error yields done event with error', async () => {
    mockAdapterCall.mockImplementation(async () => {
      throw new Error('invalid api key');
    });

    const agent = await Agent.create({ maxIterations: 2 });
    const events = await collectEvents(agent.run('broken query'));

    const doneEvent = events.find((e) => e.type === 'done')!;
    expect(doneEvent).toBeTruthy();
    expect((doneEvent as any).answer).toContain('Error');
  });
});
