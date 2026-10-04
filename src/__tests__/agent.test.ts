import { describe, expect, test, beforeEach, afterAll, mock, spyOn } from 'bun:test';
import { ensureTestProfile, collectEvents, mockTool } from './helpers.js';
import type { LlmResponse, ProviderAdapter } from '../model/types.js';
import * as realPrompts from '../agent/prompts.js';
import * as skillsIndex from '../skills/index.js';
import * as realSkillLoader from '../skills/loader.js';
import * as realOrchRegistry from '../orchestration/registry.js';

// Link the real modules BEFORE mock.module below so bun mutates them in place
// (instead of wholesale-replacing them and their re-export graph) — keeps
// ../skills/loader.js real for skills-loader.test.ts.
void skillsIndex;

// Spy (not mock.module) on getOrchestrationTools so the agent's tool registry
// stays light while orchestration-registry.test.ts keeps the real function
// after mockRestore().
const orchToolsSpy = spyOn(realOrchRegistry, 'getOrchestrationTools').mockImplementation(async () => []);

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
// Spread the real module first so DB-backed context helpers (initGoalContext /
// buildGoalContext, etc.) stay available to other test files — only the
// filesystem-reading functions are actually mocked here.
mock.module('../agent/prompts.js', () => ({
  ...realPrompts,
  buildSystemPrompt: mock(async () => 'You are a financial assistant.'),
  buildIterationPrompt: mock((_q: string, _results: string, _usage: string | null) => 'iteration prompt'),
  loadSoulDocument: mock(async () => ''),
  buildBudgetContext: mock(() => null),
  buildDataContext: mock(() => null),
  buildProfileContext: mock(() => null),
  // buildGoalContext stays real (DB-backed, no filesystem) so other test files
  // importing it after this mock resolves still exercise the implementation.
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

// Mock orchestration registry (used by tool registry) — see spy above.

// Mock skill discovery (used by tool registry). The factory carries the REAL
// loader functions — mock.module follows index.js's re-export graph and would
// otherwise replace ../skills/loader.js with null-throwing mocks, breaking
// skills-loader.test.ts.
mock.module('../skills/index.js', () => ({
  discoverSkills: mock(() => []),
  getSkill: mock(async () => null),
  buildSkillMetadataSection: mock(() => ''),
  clearSkillCache: mock(() => {}),
  parseSkillFile: realSkillLoader.parseSkillFile,
  loadSkillFromPath: realSkillLoader.loadSkillFromPath,
  extractSkillMetadata: realSkillLoader.extractSkillMetadata,
}));

const { Agent } = await import('../agent/agent.js');
const { getTools } = await import('../tools/registry.js');
const transformersModule = await import('../model/providers/transformers.js');
const toolCards = await import('../agent/tool-cards.js');
const { setSetting } = await import('../utils/config.js');
const { InMemoryChatHistory } = await import('../utils/in-memory-chat-history.js');
const { createFakeEmbedder } = await import('./fake-embedder.js');

const LOCAL_MODEL = 'transformers:onnx-community/granite-4.0-micro-ONNX-web';

/** Local runs never load a real model here: a chars/4 tokenizer and word-overlap embeddings. */
function stubLocalModel() {
  const counter = spyOn(transformersModule, 'getLocalTokenCounter').mockResolvedValue((t: string) => Math.ceil(t.length / 4));
  const embedder = spyOn(toolCards, 'getCardEmbedder').mockReturnValue(createFakeEmbedder().embed);
  return () => {
    counter.mockRestore();
    embedder.mockRestore();
  };
}

/** The options each adapter call received. */
function adapterCalls(): Array<Record<string, any>> {
  return (mockAdapterCall.mock.calls as unknown[][]).map((c) => c[0] as Record<string, any>);
}

afterAll(() => {
  // Undo the orchestration spy so later-loading test files
  // (orchestration-registry.test.ts) exercise the real implementation.
  orchToolsSpy.mockRestore();
});

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

    // csv_import writes, so it is approval-gated (#152): approve every call so
    // the loop keeps iterating instead of ending on a denial.
    const agent = await Agent.create({ maxIterations: 2, requestToolApproval: async () => 'allow-once' });
    const events = await collectEvents(agent.run('infinite loop'));

    const doneEvent = events.find((e) => e.type === 'done')!;
    expect(doneEvent).toBeTruthy();
    expect((doneEvent as any).answer).toContain('maximum iterations');
    expect((doneEvent as any).iterations).toBe(2);
  });

  test('validation failure is fed back and the loop continues to a final answer', async () => {
    // Iteration 1: malformed tool call (csv_import requires filePath) → schema
    // guard rejects it before the tool runs, and the error is fed back to the
    // model. Iteration 2: the model recovers with a text-only answer.
    adapterResponses = [
      makeResponse('', [{ id: 'tc1', name: 'csv_import', args: {} }]),
      makeResponse('Import failed: you must provide a file path.'),
    ];

    // Approval (#152) comes before argument validation; approve so the call
    // reaches the schema guard.
    const agent = await Agent.create({ maxIterations: 5, requestToolApproval: async () => 'allow-once' });
    const events = await collectEvents(agent.run('import my file'));

    const toolError = events.find((e) => e.type === 'tool_error')!;
    expect(toolError).toBeTruthy();
    expect((toolError as any).error).toContain("Invalid arguments for tool 'csv_import'");
    expect((toolError as any).error).toContain('filePath');

    // The loop continues after the validation failure and finishes normally
    const doneEvent = events.find((e) => e.type === 'done')!;
    expect(doneEvent).toBeTruthy();
    expect((doneEvent as any).answer).toBe('Import failed: you must provide a file path.');
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

describe('Agent tool selection (design 2026-10-03)', () => {
  beforeEach(() => {
    ensureTestProfile();
    setSetting('localToolSelection', 'auto');
    adapterResponses = [makeResponse('ok')];
    adapterCallCount = 0;
    mockAdapterCall.mockReset();
    mockAdapterCall.mockImplementation(async () => {
      const response = adapterResponses[Math.min(adapterCallCount, adapterResponses.length - 1)];
      adapterCallCount++;
      return response;
    });
  });
  afterAll(() => setSetting('localToolSelection', 'auto'));

  // R1: cloud and non-budgeted providers get exactly today's tools and prompt.
  for (const model of ['claude-sonnet-4-5', 'gpt-5.2', 'ollama:qwen3:8b', 'openrouter:openai/gpt-4o-mini']) {
    test(`${model}: every registered tool and the unchanged system prompt`, async () => {
      setSetting('localToolSelection', 'always');
      const agent = await Agent.create({ model, maxIterations: 2 });
      const events = await collectEvents(agent.run('how much did I spend on dining?'));
      const [call] = adapterCalls();
      expect(call.tools.map((t: { name: string }) => t.name)).toEqual((await getTools(model)).map((t) => t.name));
      expect(call.systemPrompt).toBe('You are a financial assistant.');
      expect(call.userPrompt).toBe('how much did I spend on dining?');
      expect('toolIndex' in call).toBe(false);
      expect(events.some((e) => e.type === ('tool_selection' as string))).toBe(false);
    });
  }

  test('local model: a subset with full schemas, the rest by name, all still registered', async () => {
    const restore = stubLocalModel();
    try {
      const agent = await Agent.create({ model: LOCAL_MODEL, maxIterations: 2 });
      await collectEvents(agent.run('import my bank statement from statement.csv'));
      const [call] = adapterCalls();
      const sent: string[] = call.tools.map((t: { name: string }) => t.name);
      const all = (await getTools(LOCAL_MODEL)).map((t) => t.name);
      expect(sent).toEqual(expect.arrayContaining(['transaction_search', 'spending_summary', 'csv_import']));
      expect(sent.length).toBeLessThan(all.length);
      expect(new Set([...sent, ...call.toolIndex])).toEqual(new Set(all));
      expect(call.userPrompt).toBe('import my bank statement from statement.csv');
    } finally {
      restore();
    }
  });

  test("local model with the setting 'off': every tool, no index", async () => {
    const restore = stubLocalModel();
    try {
      setSetting('localToolSelection', 'off');
      const agent = await Agent.create({ model: LOCAL_MODEL, maxIterations: 2 });
      await collectEvents(agent.run('import my bank statement'));
      const [call] = adapterCalls();
      expect(call.tools.map((t: { name: string }) => t.name)).toEqual((await getTools(LOCAL_MODEL)).map((t) => t.name));
      expect('toolIndex' in call).toBe(false);
    } finally {
      restore();
    }
  });

  test('local model: an embedder failure falls back to keyword groups and the run continues', async () => {
    const restore = stubLocalModel();
    const broken = spyOn(toolCards, 'getCardEmbedder').mockReturnValue(async () => {
      throw new Error('no MiniLM offline');
    });
    try {
      const agent = await Agent.create({ model: LOCAL_MODEL, maxIterations: 2 });
      const events = await collectEvents(agent.run('set a grocery budget'));
      const [call] = adapterCalls();
      expect(call.tools.map((t: { name: string }) => t.name)).toEqual(
        expect.arrayContaining(['transaction_search', 'spending_summary', 'budget_set']),
      );
      expect((events.find((e) => e.type === 'done') as any).answer).toBe('ok');
    } finally {
      broken.mockRestore();
      restore();
    }
  });

  test('local model: long chat history is trimmed to the budget instead of failing', async () => {
    const restore = stubLocalModel();
    try {
      const history = new InMemoryChatHistory(LOCAL_MODEL);
      for (let i = 0; i < 10; i++) {
        history.saveUserQuery(`question ${i}`);
        await history.saveAnswer(`answer ${i} ${'x'.repeat(8000)}`);
      }
      history.saveUserQuery('and now?');
      mockAdapterCall.mockClear(); // drop the summary calls saveAnswer made
      const agent = await Agent.create({ model: LOCAL_MODEL, maxIterations: 2 });
      const events = await collectEvents(agent.run('and now?', history));
      const [call] = adapterCalls();
      const tokens = Math.ceil(call.userPrompt.length / 4) + Math.ceil(call.systemPrompt.length / 4);
      expect(tokens).toBeLessThan(8192);
      expect(call.userPrompt).toContain('answer 9');
      expect(call.userPrompt).not.toContain('answer 0 ');
      expect((events.find((e) => e.type === 'done') as any).answer).toBe('ok');
    } finally {
      restore();
    }
  });
});
