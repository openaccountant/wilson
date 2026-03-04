import { describe, expect, test, beforeEach } from 'bun:test';
import { interactionStore } from '../utils/interaction-store.js';
import { createTestDb } from './helpers.js';
import type { Database } from '../db/compat-sqlite.js';

function makeInteractionRecord(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'test-run-1',
    sequenceNum: 1,
    callType: 'agent',
    model: 'gpt-5.2',
    provider: 'openai',
    systemPrompt: 'You are a financial assistant.',
    userPrompt: 'Show my spending',
    responseContent: 'Here is your spending summary.',
    toolCalls: [],
    toolDefs: ['spending_summary'],
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    durationMs: 1200,
    status: 'ok' as const,
    ...overrides,
  };
}

describe('InteractionStore', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    interactionStore.setDatabase(db);
  });

  test('recordInteraction inserts and returns ID', () => {
    const id = interactionStore.recordInteraction(makeInteractionRecord());
    expect(id).toBeGreaterThan(0);
  });

  test('recordInteraction returns sequential IDs', () => {
    const id1 = interactionStore.recordInteraction(makeInteractionRecord({ sequenceNum: 1 }));
    const id2 = interactionStore.recordInteraction(makeInteractionRecord({ sequenceNum: 2 }));
    const id3 = interactionStore.recordInteraction(makeInteractionRecord({ sequenceNum: 3 }));
    expect(id1).toBe(1);
    expect(id2).toBe(2);
    expect(id3).toBe(3);
  });

  test('recordInteraction stores tool calls as JSON', () => {
    const toolCalls = [{ id: 'tc1', name: 'spending_summary', args: { month: '2026-02' } }];
    const id = interactionStore.recordInteraction(makeInteractionRecord({ toolCalls }));
    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT tool_calls_json FROM llm_interactions WHERE id = @id').get({ id }) as { tool_calls_json: string };
    const parsed = JSON.parse(row.tool_calls_json);
    expect(parsed[0].name).toBe('spending_summary');
  });

  test('recordToolResult inserts successfully', () => {
    const interactionId = interactionStore.recordInteraction(makeInteractionRecord());
    expect(interactionId).not.toBeNull();

    interactionStore.recordToolResult({
      interactionId: interactionId!,
      toolCallId: 'tc-1',
      toolName: 'spending_summary',
      toolArgs: { month: '2026-02' },
      toolResult: '{"total": 500}',
      durationMs: 200,
    });

    const row = db.prepare('SELECT * FROM llm_tool_results WHERE interaction_id = @interaction_id').get({ interaction_id: interactionId! }) as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.tool_name).toBe('spending_summary');
    expect(row.tool_result).toBe('{"total": 500}');
  });

  test('recordToolResult does not throw on error', () => {
    // Call with an invalid interaction_id (no matching FK if constraints active)
    // The method has try/catch so should not throw
    expect(() => {
      interactionStore.recordToolResult({
        interactionId: 99999,
        toolCallId: 'tc-bad',
        toolName: 'test',
        toolArgs: {},
        toolResult: 'test',
        durationMs: 0,
      });
    }).not.toThrow();
  });

  test('recordInteraction with error status', () => {
    const id = interactionStore.recordInteraction(makeInteractionRecord({
      status: 'error',
      error: 'rate limit exceeded',
      responseContent: '',
    }));
    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT status, error FROM llm_interactions WHERE id = @id').get({ id }) as { status: string; error: string };
    expect(row.status).toBe('error');
    expect(row.error).toBe('rate limit exceeded');
  });
});
