import { describe, expect, test, beforeEach, afterAll, mock, spyOn } from 'bun:test';
import { ensureTestProfile, collectEvents, createTestDb, mockTool } from './helpers.js';
import type { LlmResponse, ProviderAdapter } from '../model/types.js';
import * as realPrompts from '../agent/prompts.js';
import * as skillsIndex from '../skills/index.js';
import * as realOrchRegistry from '../orchestration/registry.js';

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

// Stub skill discovery (used by tool registry) with spies, not mock.module: a
// module mock on skills/index.js is never undone, and another file's spy
// restore (tool-registry.test.ts) over it left discoverSkills() returning
// undefined for later files (tool-selection-recall) without --isolate.
const skillSpies = [
  spyOn(skillsIndex, 'discoverSkills').mockImplementation(() => []),
  spyOn(skillsIndex, 'getSkill').mockImplementation(async () => undefined),
  spyOn(skillsIndex, 'buildSkillMetadataSection').mockImplementation(() => ''),
  spyOn(skillsIndex, 'clearSkillCache').mockImplementation(() => {}),
];

const { Agent } = await import('../agent/agent.js');
const { getTools } = await import('../tools/registry.js');
const transformersModule = await import('../model/providers/transformers.js');
const toolCards = await import('../agent/tool-cards.js');
const { setSetting } = await import('../utils/config.js');
const { InMemoryChatHistory } = await import('../utils/in-memory-chat-history.js');
const { createFakeEmbedder } = await import('./fake-embedder.js');
const prompts = await import('../agent/prompts.js');
const { initSpendingSummaryTool } = await import('../tools/query/spending-summary.js');
const { insertTransactions } = await import('../db/queries.js');

const LOCAL_MODEL = 'transformers:onnx-community/granite-4.0-micro-ONNX-web';

/** Local runs never load a real model here: a chars/4 tokenizer and word-overlap embeddings. */
function stubLocalModel() {
  const counter = spyOn(transformersModule, 'getLocalTokenCounter').mockResolvedValue((t: string) => Math.ceil(t.length / 4));
  const embedder = spyOn(toolCards, 'getCardEmbedder').mockReturnValue(createFakeEmbedder({ isolatedVocabulary: true }).embed);
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
  for (const s of skillSpies) s.mockRestore();
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
    (prompts.buildIterationPrompt as unknown as { mockClear: () => void }).mockClear();
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

  test('local model: an indexed tool called with bad args gets its schema back, unapproved and unrun', async () => {
    const restore = stubLocalModel();
    try {
      adapterResponses = [
        makeResponse('', [{ id: 'tc1', name: 'mortgage_manage', args: {} }]),
        makeResponse('done'),
      ];
      let approvals = 0;
      const agent = await Agent.create({
        model: LOCAL_MODEL,
        maxIterations: 3,
        requestToolApproval: async () => {
          approvals++;
          return 'allow-once';
        },
      });
      const events = await collectEvents(agent.run('import my bank statement from statement.csv'));
      expect(adapterCalls()[0].toolIndex).toContain('mortgage_manage');
      const err = events.find((e) => e.type === 'tool_error') as any;
      expect(err.error).toContain('Tool mortgage_manage needs these arguments:');
      expect(err.error).toContain('"action"');
      expect(approvals).toBe(0);
      expect((events.find((e) => e.type === 'done') as any).answer).toBe('done');
    } finally {
      restore();
    }
  });

  test('local model: the set grows during a run (called tool, affinities) and each change is reported', async () => {
    const restore = stubLocalModel();
    try {
      adapterResponses = [
        makeResponse('', [{ id: 'tc1', name: 'transaction_search', args: { query: 'netflix' } }]),
        makeResponse('', [{ id: 'tc2', name: 'mortgage_manage', args: { action: 'summary' } }]),
        makeResponse('done'),
      ];
      const agent = await Agent.create({ model: LOCAL_MODEL, maxIterations: 4, requestToolApproval: async () => 'allow-once' });
      const events = await collectEvents(agent.run('import my bank statement from statement.csv'));
      const sent = adapterCalls().map((c) => c.tools.map((t: { name: string }) => t.name) as string[]);
      expect(sent).toHaveLength(3);
      // After the search: edit/delete join (search → act).
      expect(sent[0]).not.toContain('delete_transaction');
      expect(sent[1]).toEqual(expect.arrayContaining(['edit_transaction', 'delete_transaction']));
      // After calling an indexed tool: it joins; nothing seen earlier is removed.
      expect(sent[2]).toContain('mortgage_manage');
      for (const name of sent[0]) expect(sent[1]).toContain(name);
      for (const name of sent[1]) expect(sent[2]).toContain(name);
      expect(adapterCalls()[2].toolIndex).not.toContain('mortgage_manage');

      const selections = events.filter((e) => e.type === 'tool_selection') as any[];
      expect(selections).toHaveLength(3);
      expect(selections[0].tools).toEqual(sent[0]);
      expect(selections[1].reasons.delete_transaction).toBe('after transaction_search');
      expect(selections[2].reasons.mortgage_manage).toBe('called');
      expect(selections[0].tokens.budget).toBe(8192);
      expect(selections[0].tokens.total).toBeLessThanOrEqual(8192);
    } finally {
      restore();
    }
  });

  test('local model: tools used in the last turns stay selected; the run records what it called', async () => {
    const restore = stubLocalModel();
    try {
      const history = new InMemoryChatHistory(LOCAL_MODEL);
      history.saveUserQuery('hello there');
      history.recordToolsUsed(['mortgage_manage']);
      await history.saveAnswer('Hi.');
      history.saveUserQuery('and then?');
      mockAdapterCall.mockClear();
      adapterResponses = [
        makeResponse('', [{ id: 'tc1', name: 'spending_summary', args: {} }]),
        makeResponse('done'),
      ];
      adapterCallCount = 0;
      const agent = await Agent.create({ model: LOCAL_MODEL, maxIterations: 3 });
      await collectEvents(agent.run('and then?', history));
      expect(adapterCalls()[0].tools.map((t: { name: string }) => t.name)).toContain('mortgage_manage');
      expect(history.getMessages().at(-1)!.toolsUsed).toEqual(['spending_summary']);
    } finally {
      restore();
    }
  });

  // Granite asked "biggest expenses in August 2026?" called spending_summary
  // for the current month, then answered with the tool block verbatim.
  const ECHO = '### spending_summary(period=month, compareWithPrevious=true)\n{"data":{"period":"August 2025"}}';
  const summaryCall = () => makeResponse('', [{ id: 'tc1', name: 'spending_summary', args: { period: 'month', compareWithPrevious: true } }]);
  const iterationPromptCalls = () => (prompts.buildIterationPrompt as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  beforeEach(() => {
    const db = createTestDb();
    insertTransactions(db, [{ date: '2025-08-12', description: 'Airline', amount: -640, category: 'Travel' }]);
    initSpendingSummaryTool(db);
  });

  test('local model: a month named in the query is filled into spending_summary', async () => {
    const restore = stubLocalModel();
    try {
      adapterResponses = [summaryCall(), makeResponse('done')];
      const agent = await Agent.create({ model: LOCAL_MODEL, maxIterations: 3 });
      const events = await collectEvents(agent.run('What were my biggest expenses in August 2025?'));
      const start = events.find((e) => e.type === 'tool_start') as any;
      expect(start.args).toEqual({ period: 'month', compareWithPrevious: true, month: '2025-08' });
      const end = events.find((e) => e.type === 'tool_end') as any;
      expect(JSON.parse(end.result).data.period).toBe('August 2025');
    } finally {
      restore();
    }
  });

  test('cloud model: spending_summary arguments are left as the model wrote them', async () => {
    adapterResponses = [summaryCall(), makeResponse('done')];
    const agent = await Agent.create({ model: 'claude-sonnet-4-5', maxIterations: 3 });
    const events = await collectEvents(agent.run('What were my biggest expenses in August 2025?'));
    expect((events.find((e) => e.type === 'tool_start') as any).args).toEqual({ period: 'month', compareWithPrevious: true });
  });

  test('local model: an answer copying the tool results is re-prompted once', async () => {
    const restore = stubLocalModel();
    try {
      adapterResponses = [summaryCall(), makeResponse(ECHO), makeResponse('Travel was your biggest expense at $640.')];
      const agent = await Agent.create({ model: LOCAL_MODEL, maxIterations: 5 });
      const events = await collectEvents(agent.run('What were my biggest expenses in August 2025?'));
      expect(adapterCalls()).toHaveLength(3);
      const options = iterationPromptCalls().map((c) => c[3] as Record<string, unknown> | undefined);
      expect(options.at(-1)).toEqual({ local: true, retry: true });
      expect(options.some((o) => o?.local === true && !o.retry)).toBe(true);
      expect((events.find((e) => e.type === 'done') as any).answer).toBe('Travel was your biggest expense at $640.');
    } finally {
      restore();
    }
  });

  test('local model: a second copy falls back to the formatted summary, never the raw block', async () => {
    const restore = stubLocalModel();
    try {
      adapterResponses = [summaryCall(), makeResponse(ECHO), makeResponse(ECHO)];
      const agent = await Agent.create({ model: LOCAL_MODEL, maxIterations: 5 });
      const events = await collectEvents(agent.run('What were my biggest expenses in August 2025?'));
      expect(adapterCalls()).toHaveLength(3);
      const answer = (events.find((e) => e.type === 'done') as any).answer as string;
      expect(answer).toStartWith("Here's what I found:");
      expect(answer).toContain('Spending Summary: August 2025');
      expect(answer).not.toContain('###');
      expect(answer).not.toContain('"data"');
    } finally {
      restore();
    }
  });

  test('cloud model: the answer is never checked or rewritten', async () => {
    adapterResponses = [summaryCall(), makeResponse(ECHO)];
    const agent = await Agent.create({ model: 'claude-sonnet-4-5', maxIterations: 5 });
    const events = await collectEvents(agent.run('What were my biggest expenses?'));
    expect(adapterCalls()).toHaveLength(2);
    expect((events.find((e) => e.type === 'done') as any).answer).toBe(ECHO);
    expect(iterationPromptCalls().every((c) => c[3] === undefined)).toBe(true);
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
