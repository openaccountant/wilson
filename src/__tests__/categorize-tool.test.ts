import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { initCategorizeTool, categorizeTool } from '../tools/categorize/categorize.js';
import { insertTransactions, getTransactions, addRule } from '../db/queries.js';
import { createTestDb } from './helpers.js';
import * as llmModule from '../model/llm.js';

describe('categorize tool', () => {
  let db: Database;
  let llmSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    db = createTestDb();
    initCategorizeTool(db);
    // Mock callLlm to prevent actual LLM calls
    llmSpy = spyOn(llmModule, 'callLlm');
  });

  afterEach(() => {
    llmSpy.mockRestore();
  });

  test('all categorized returns message', async () => {
    insertTransactions(db, [
      { date: '2026-02-15', description: 'Store', amount: -50, category: 'Shopping' },
    ]);
    initCategorizeTool(db);

    const raw = await categorizeTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.message).toContain('already categorized');
    expect(result.data.categorized).toBe(0);
  });

  test('rules path categorizes without LLM', async () => {
    insertTransactions(db, [
      { date: '2026-02-15', description: 'AMAZON PURCHASE', amount: -50 },
      { date: '2026-02-18', description: 'STARBUCKS COFFEE', amount: -5 },
    ]);
    // Add rules that match these transactions
    addRule(db, '*AMAZON*', 'Shopping');
    addRule(db, '*STARBUCKS*', 'Dining');
    initCategorizeTool(db);

    const raw = await categorizeTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(result.data.ruleMatched).toBe(2);
    expect(result.data.llmCategorized).toBe(0);
    // LLM should not have been called
    expect(llmSpy).not.toHaveBeenCalled();
  });

  test('rules apply correct categories', async () => {
    insertTransactions(db, [
      { date: '2026-02-15', description: 'AMAZON ORDER #123', amount: -75 },
    ]);
    addRule(db, '*AMAZON*', 'Shopping');
    initCategorizeTool(db);

    await categorizeTool.func({});
    const txns = getTransactions(db);
    expect(txns[0].category).toBe('Shopping');
  });

  test('LLM path called for unmatched transactions', async () => {
    insertTransactions(db, [
      { date: '2026-02-15', description: 'Mystery Store', amount: -50 },
    ]);
    initCategorizeTool(db);

    // Mock LLM response with valid categorization
    const txns = getTransactions(db);
    llmSpy.mockResolvedValue({
      response: {
        content: '',
        structured: {
          transactions: [{ id: txns[0].id, category: 'Shopping', confidence: 0.9 }],
        },
      },
      metadata: {},
    });

    const raw = await categorizeTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(result.data.llmCategorized).toBe(1);
    expect(llmSpy).toHaveBeenCalled();
  });

  test('mixed rules and LLM categorization', async () => {
    insertTransactions(db, [
      { date: '2026-02-15', description: 'AMAZON PURCHASE', amount: -50 },
      { date: '2026-02-18', description: 'Unknown Vendor', amount: -30 },
    ]);
    addRule(db, '*AMAZON*', 'Shopping');
    initCategorizeTool(db);

    const txns = getTransactions(db);
    const unknownTxn = txns.find(t => t.description === 'Unknown Vendor');
    llmSpy.mockResolvedValue({
      response: {
        content: '',
        structured: {
          transactions: [{ id: unknownTxn!.id, category: 'Other', confidence: 0.6 }],
        },
      },
      metadata: {},
    });

    const raw = await categorizeTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.ruleMatched).toBe(1);
    expect(result.data.llmCategorized).toBe(1);
    expect(result.data.needingReview).toBe(1); // confidence < 0.7
  });

  test('limit parameter restricts batch size', async () => {
    insertTransactions(db, [
      { date: '2026-02-15', description: 'AMAZON ONE', amount: -50 },
      { date: '2026-02-16', description: 'AMAZON TWO', amount: -30 },
      { date: '2026-02-17', description: 'AMAZON THREE', amount: -20 },
    ]);
    addRule(db, '*AMAZON*', 'Shopping');
    initCategorizeTool(db);

    const raw = await categorizeTool.func({ limit: 2 });
    const result = JSON.parse(raw as string);
    expect(result.data.categorized).toBe(2);
    expect(result.data.totalUncategorized).toBe(2);
  });

  test('LLM error is reported in errors array', async () => {
    insertTransactions(db, [
      { date: '2026-02-15', description: 'Mystery Store', amount: -50 },
    ]);
    initCategorizeTool(db);

    llmSpy.mockRejectedValue(new Error('LLM rate limited'));

    const raw = await categorizeTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.errors).toBeDefined();
    expect(result.data.errors.length).toBeGreaterThan(0);
    expect(result.data.errors[0]).toContain('rate limited');
  });
});
