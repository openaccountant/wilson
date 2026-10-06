import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { initCategorizeTool } from '../tools/categorize/categorize.js';
import { insertTransactions, addRule, getTransactions } from '../db/queries.js';
import { addPendingCategorizationReview } from '../db/categorization-review-queries.js';
import { handleChatMessage } from '../dashboard/chat.js';
import * as llmModule from '../model/llm.js';
import { createTestDb, ensureTestProfile } from './helpers.js';
import { saveConfig, setSetting } from '../utils/config.js';

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

  test('on a local model a bare /categorize does one chunk of 50 and says how many remain', async () => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'transformers:onnx-community/granite-4.0-micro-ONNX-web');
    setSetting('provider', 'transformers');
    try {
      insertTransactions(db, Array.from({ length: 60 }, (_, i) => ({ date: '2026-02-15', description: `AMAZON ${i}`, amount: -10 })));
      addRule(db, '*AMAZON*', 'Shopping');
      const res = await handleChatMessage('/categorize');
      expect(res.answer).toStartWith('Categorized **50** of 50 transactions');
      expect(res.answer).toContain('10 transactions are still uncategorized');
      expect(res.answer).toContain('/categorize');
    } finally {
      saveConfig({});
    }
  });

  test('an explicit limit is honoured on a local model, with the remainder noted', async () => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'transformers:onnx-community/granite-4.0-micro-ONNX-web');
    setSetting('provider', 'transformers');
    try {
      insertTransactions(db, Array.from({ length: 5 }, (_, i) => ({ date: '2026-02-15', description: `AMAZON ${i}`, amount: -10 })));
      addRule(db, '*AMAZON*', 'Shopping');
      const res = await handleChatMessage('/categorize 3');
      expect(res.answer).toStartWith('Categorized **3** of 3 transactions');
      expect(res.answer).toContain('2 transactions are still uncategorized');
    } finally {
      saveConfig({});
    }
  });

  test('held-for-review transactions do not stall chunks and the note names the review backlog', async () => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'transformers:onnx-community/granite-4.0-micro-ONNX-web');
    setSetting('provider', 'transformers');
    try {
      insertTransactions(db, [
        { date: '2026-03-01', description: 'HELD ONE', amount: -10 },
        { date: '2026-03-02', description: 'HELD TWO', amount: -10 },
        { date: '2026-02-01', description: 'AMAZON A', amount: -10 },
        { date: '2026-02-02', description: 'AMAZON B', amount: -10 },
        { date: '2026-02-03', description: 'AMAZON C', amount: -10 },
      ]);
      addRule(db, '*AMAZON*', 'Shopping');
      for (const t of getTransactions(db).filter((t) => t.description.startsWith('HELD'))) {
        addPendingCategorizationReview(db, t.id, 'Other', 0.5);
      }
      const res = await handleChatMessage('/categorize 2');
      expect(res.answer).toStartWith('Categorized **2** of 2 transactions');
      expect(res.answer).toContain('3 transactions are still uncategorized (2 of them waiting in the Review tab)');
      expect(res.answer).toContain('send `/categorize` again');

      const last = await handleChatMessage('/categorize 2');
      expect(last.answer).toStartWith('Categorized **1** of 1 transactions');
      expect(last.answer).toContain('2 transactions are still uncategorized (2 of them waiting in the Review tab).');
      expect(last.answer).not.toContain('send `/categorize` again');
      expect(llmSpy).not.toHaveBeenCalled();
    } finally {
      saveConfig({});
    }
  });

  // No limit (non-local provider): the unchunked path must still name the backlog.
  test('unchunked run with only held transactions left answers coherently', async () => {
    insertTransactions(db, [
      { date: '2026-03-01', description: 'HELD ONE', amount: -10 },
      { date: '2026-03-02', description: 'HELD TWO', amount: -10 },
    ]);
    for (const t of getTransactions(db)) addPendingCategorizationReview(db, t.id, 'Other', 0.5);
    const res = await handleChatMessage('/categorize');
    expect(res.answer).toBe('No new transactions to categorize — 2 are waiting for your review in the Review tab.');
    expect(res.answer).not.toContain('already categorized');
    expect(llmSpy).not.toHaveBeenCalled();
  });

  test('unchunked run that categorizes some still notes the held backlog', async () => {
    insertTransactions(db, [
      { date: '2026-03-01', description: 'HELD ONE', amount: -10 },
      { date: '2026-02-01', description: 'AMAZON A', amount: -10 },
      { date: '2026-02-02', description: 'AMAZON B', amount: -10 },
    ]);
    addRule(db, '*AMAZON*', 'Shopping');
    for (const t of getTransactions(db).filter((t) => t.description.startsWith('HELD'))) {
      addPendingCategorizationReview(db, t.id, 'Other', 0.5);
    }
    const res = await handleChatMessage('/categorize');
    expect(res.answer).toStartWith('Categorized **2** of 2 transactions');
    expect(res.answer).toContain('1 transactions are still uncategorized (1 of them waiting in the Review tab).');
    expect(res.answer).not.toContain('send `/categorize` again');
    expect(llmSpy).not.toHaveBeenCalled();
  });

  test('chunked run where every remaining transaction is held answers coherently', async () => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'transformers:onnx-community/granite-4.0-micro-ONNX-web');
    setSetting('provider', 'transformers');
    try {
      insertTransactions(db, [{ date: '2026-03-01', description: 'HELD ONE', amount: -10 }]);
      for (const t of getTransactions(db)) addPendingCategorizationReview(db, t.id, 'Other', 0.5);
      const res = await handleChatMessage('/categorize 5');
      expect(res.answer).toBe('No new transactions to categorize — 1 are waiting for your review in the Review tab.');
    } finally {
      saveConfig({});
    }
  });
});
