import { describe, test, expect, beforeEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb } from './helpers.js';
import { exportSftJsonl, exportDpoJsonl, getTrainingStats } from '../training/export.js';

function insertInteraction(db: Database, opts: {
  run_id: string;
  sequence_num?: number;
  call_type?: string;
  model?: string;
  system_prompt?: string | null;
  user_prompt: string;
  response_content?: string;
  tool_calls_json?: string | null;
}): number {
  const result = db.prepare(`
    INSERT INTO llm_interactions
      (run_id, sequence_num, call_type, model, provider, system_prompt, user_prompt, response_content, tool_calls_json, status)
    VALUES (@run_id, @sequence_num, @call_type, @model, @provider, @system_prompt, @user_prompt, @response_content, @tool_calls_json, 'ok')
  `).run({
    run_id: opts.run_id,
    sequence_num: opts.sequence_num ?? 1,
    call_type: opts.call_type ?? 'agent',
    model: opts.model ?? 'gpt-4',
    provider: 'openai',
    system_prompt: opts.system_prompt ?? null,
    user_prompt: opts.user_prompt,
    response_content: opts.response_content ?? 'Sure, here is the answer.',
    tool_calls_json: opts.tool_calls_json ?? null,
  });
  return (result as { lastInsertRowid: number }).lastInsertRowid as number;
}

function insertAnnotation(db: Database, opts: {
  interaction_id: number;
  rating?: number | null;
  preference?: string | null;
  pair_id?: string | null;
}): void {
  db.prepare(`
    INSERT INTO interaction_annotations (interaction_id, rating, preference, pair_id)
    VALUES (@interaction_id, @rating, @preference, @pair_id)
  `).run({
    interaction_id: opts.interaction_id,
    rating: opts.rating ?? null,
    preference: opts.preference ?? null,
    pair_id: opts.pair_id ?? null,
  });
}

function insertToolResult(db: Database, opts: {
  interaction_id: number;
  tool_call_id: string;
  tool_name: string;
  tool_result?: string;
}): void {
  db.prepare(`
    INSERT INTO llm_tool_results (interaction_id, tool_call_id, tool_name, tool_args_json, tool_result)
    VALUES (@interaction_id, @tool_call_id, @tool_name, @tool_args_json, @tool_result)
  `).run({
    interaction_id: opts.interaction_id,
    tool_call_id: opts.tool_call_id,
    tool_name: opts.tool_name,
    tool_args_json: '{}',
    tool_result: opts.tool_result ?? 'result',
  });
}

describe('training export', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  describe('exportSftJsonl', () => {
    test('empty db returns empty string', () => {
      const result = exportSftJsonl(db);
      expect(result).toBe('');
    });

    test('with rated interactions returns valid JSONL', () => {
      const id = insertInteraction(db, {
        run_id: 'run-1',
        system_prompt: 'You are a helpful assistant.',
        user_prompt: 'What is my balance?',
        response_content: 'Your balance is $1000.',
      });
      insertAnnotation(db, { interaction_id: id, rating: 5 });

      const result = exportSftJsonl(db);
      expect(result.length).toBeGreaterThan(0);

      const parsed = JSON.parse(result);
      expect(parsed.messages).toBeDefined();
      expect(parsed.messages.length).toBeGreaterThanOrEqual(3); // system + user + assistant
      expect(parsed.messages[0].role).toBe('system');
      expect(parsed.messages[1].role).toBe('user');
      expect(parsed.messages[2].role).toBe('assistant');
    });

    test('with tool calls includes tool_calls field', () => {
      const toolCalls = JSON.stringify([
        { id: 'tc-1', name: 'transaction_search', args: { query: 'groceries' } },
      ]);
      const id = insertInteraction(db, {
        run_id: 'run-2',
        user_prompt: 'Find grocery transactions',
        response_content: 'Found 3 transactions.',
        tool_calls_json: toolCalls,
      });
      insertAnnotation(db, { interaction_id: id, rating: 4 });
      insertToolResult(db, {
        interaction_id: id,
        tool_call_id: 'tc-1',
        tool_name: 'transaction_search',
        tool_result: '[{"description": "Grocery Store", "amount": -85}]',
      });

      const result = exportSftJsonl(db);
      const parsed = JSON.parse(result);
      const assistantMsg = parsed.messages.find((m: { role: string }) => m.role === 'assistant');
      expect(assistantMsg.tool_calls).toBeDefined();
      expect(assistantMsg.tool_calls[0].function.name).toBe('transaction_search');

      const toolMsg = parsed.messages.find((m: { role: string }) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg.tool_call_id).toBe('tc-1');
    });

    test('filter by model', () => {
      const id1 = insertInteraction(db, {
        run_id: 'run-3',
        model: 'gpt-4',
        user_prompt: 'Q1',
        response_content: 'A1',
      });
      insertAnnotation(db, { interaction_id: id1, rating: 5 });

      const id2 = insertInteraction(db, {
        run_id: 'run-4',
        model: 'claude-3',
        user_prompt: 'Q2',
        response_content: 'A2',
      });
      insertAnnotation(db, { interaction_id: id2, rating: 5 });

      const gptOnly = exportSftJsonl(db, { model: 'gpt-4' });
      const claudeOnly = exportSftJsonl(db, { model: 'claude-3' });

      // Each should produce exactly one line
      expect(gptOnly.split('\n').filter(Boolean)).toHaveLength(1);
      expect(claudeOnly.split('\n').filter(Boolean)).toHaveLength(1);

      const gptParsed = JSON.parse(gptOnly);
      expect(gptParsed.messages.find((m: { role: string }) => m.role === 'user').content).toBe('Q1');

      const claudeParsed = JSON.parse(claudeOnly);
      expect(claudeParsed.messages.find((m: { role: string }) => m.role === 'user').content).toBe('Q2');
    });

    test('low-rated interactions are excluded', () => {
      const id = insertInteraction(db, {
        run_id: 'run-5',
        user_prompt: 'Bad answer',
        response_content: 'Wrong info.',
      });
      insertAnnotation(db, { interaction_id: id, rating: 2 });

      const result = exportSftJsonl(db);
      expect(result).toBe('');
    });
  });

  describe('exportDpoJsonl', () => {
    test('no pairs returns empty', () => {
      const result = exportDpoJsonl(db);
      expect(result).toBe('');
    });

    test('with chosen/rejected pair returns valid JSONL', () => {
      const chosenId = insertInteraction(db, {
        run_id: 'run-dpo-1',
        system_prompt: 'Be helpful.',
        user_prompt: 'Summarize my spending',
        response_content: 'Good detailed answer.',
      });
      const rejectedId = insertInteraction(db, {
        run_id: 'run-dpo-2',
        system_prompt: 'Be helpful.',
        user_prompt: 'Summarize my spending',
        response_content: 'Bad vague answer.',
      });

      insertAnnotation(db, { interaction_id: chosenId, preference: 'chosen', pair_id: 'pair-1' });
      insertAnnotation(db, { interaction_id: rejectedId, preference: 'rejected', pair_id: 'pair-1' });

      const result = exportDpoJsonl(db);
      expect(result.length).toBeGreaterThan(0);

      const parsed = JSON.parse(result);
      expect(parsed.prompt).toBe('Summarize my spending');
      expect(parsed.chosen).toBeDefined();
      expect(parsed.rejected).toBeDefined();

      const chosenAssistant = parsed.chosen.find((m: { role: string }) => m.role === 'assistant');
      expect(chosenAssistant.content).toBe('Good detailed answer.');

      const rejectedAssistant = parsed.rejected.find((m: { role: string }) => m.role === 'assistant');
      expect(rejectedAssistant.content).toBe('Bad vague answer.');
    });
  });

  describe('getTrainingStats', () => {
    test('empty db returns all zeros', () => {
      const stats = getTrainingStats(db);
      expect(stats.totalInteractions).toBe(0);
      expect(stats.annotated).toBe(0);
      expect(stats.sftReady).toBe(0);
      expect(stats.dpoPairs).toBe(0);
    });

    test('with data returns correct counts', () => {
      const id1 = insertInteraction(db, { run_id: 'stats-1', user_prompt: 'Q1' });
      const id2 = insertInteraction(db, { run_id: 'stats-2', user_prompt: 'Q2' });
      insertInteraction(db, { run_id: 'stats-3', user_prompt: 'Q3' }); // no annotation

      insertAnnotation(db, { interaction_id: id1, rating: 5 });
      insertAnnotation(db, { interaction_id: id2, rating: 3, pair_id: 'pair-stats' });

      const stats = getTrainingStats(db);
      expect(stats.totalInteractions).toBe(3);
      expect(stats.annotated).toBe(2);
      expect(stats.sftReady).toBe(1); // only rating >= 4
      expect(stats.dpoPairs).toBe(1);
    });
  });
});
