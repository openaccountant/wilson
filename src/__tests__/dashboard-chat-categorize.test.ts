import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { initCategorizeTool } from '../tools/categorize/categorize.js';
import { insertTransactions, addRule } from '../db/queries.js';
import { handleChatMessage } from '../dashboard/chat.js';
import * as llmModule from '../model/llm.js';
import { createTestDb } from './helpers.js';

// "/categorize" in the dashboard chat must never go through the agent loop:
// the agent prompt (~17k tokens with every tool schema) overwhelms local
// models, and the agent gates `categorize` behind an approval the dashboard
// chat has no UI for — either way the HTTP request never came back. It runs
// the categorize tool directly, exactly like the terminal's /categorize.
describe('dashboard /categorize', () => {
  let db: Database;
  let llmSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    db = createTestDb();
    initCategorizeTool(db);
    llmSpy = spyOn(llmModule, 'callLlm');
  });

  afterEach(() => {
    llmSpy.mockRestore();
  });

  test('runs without an agent session and answers with the CLI summary', async () => {
    insertTransactions(db, [
      { date: '2026-02-15', description: 'AMAZON PURCHASE', amount: -50 },
      { date: '2026-02-18', description: 'STARBUCKS COFFEE', amount: -5 },
    ]);
    addRule(db, '*AMAZON*', 'Shopping');
    addRule(db, '*STARBUCKS*', 'Dining');

    // No initChatSession: the agent path would answer "Chat session not initialized."
    const res = await handleChatMessage('/categorize', 'sess-1');
    expect(res.sessionId).toBe('sess-1');
    expect(res.answer).toStartWith('Categorized **2** of 2 transactions (2 by rules, 0 by AI)');
    expect(llmSpy).not.toHaveBeenCalled();
  });

  test('honours the limit', async () => {
    insertTransactions(db, [
      { date: '2026-02-15', description: 'AMAZON ONE', amount: -50 },
      { date: '2026-02-16', description: 'AMAZON TWO', amount: -60 },
      { date: '2026-02-17', description: 'AMAZON THREE', amount: -70 },
    ]);
    addRule(db, '*AMAZON*', 'Shopping');
    const res = await handleChatMessage('/categorize 2');
    expect(res.answer).toStartWith('Categorized **2** of 2 transactions');
  });

  test('a model failure comes back as an answer naming the reason, never a hang', async () => {
    insertTransactions(db, [{ date: '2026-02-15', description: 'MYSTERY VENDOR', amount: -12 }]);
    llmSpy.mockImplementation(async () => {
      throw new Error('[Transformers.js (local) API] Unknown failure');
    });
    const res = await handleChatMessage('/categorize');
    expect(res.answer).toContain('Categorized 0 of 1 transactions');
    expect(res.answer).toContain('1 batch errors occurred');
    expect(res.answer).toContain('Unknown failure');
  });

  test('nothing to do', async () => {
    insertTransactions(db, [{ date: '2026-02-15', description: 'Store', amount: -50, category: 'Shopping' }]);
    const res = await handleChatMessage('/categorize');
    expect(res.answer).toBe('All transactions are already categorized.');
    expect(llmSpy).not.toHaveBeenCalled();
  });
});
