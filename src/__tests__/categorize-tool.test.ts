import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { initCategorizeTool, categorizeTool } from '../tools/categorize/categorize.js';
import { insertTransactions, getTransactions, addRule } from '../db/queries.js';
import {
  addPendingCategorizationReview,
  countPendingCategorizationReviews,
  getPendingCategorizationReviews,
} from '../db/categorization-review-queries.js';
import { setSetting, CATEGORIZATION_CONFIDENCE_THRESHOLD_KEY, DEFAULT_CATEGORIZATION_CONFIDENCE_THRESHOLD } from '../utils/config.js';
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
    // Above threshold: applied exactly as before, nothing routed to review
    expect(result.data.routedForReview).toBe(0);
    const after = getTransactions(db);
    expect(after[0].category).toBe('Shopping');
    expect(countPendingCategorizationReviews(db)).toBe(0);
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
    // Below-threshold LLM suggestion is NOT applied — routed for review instead
    expect(result.data.routedForReview).toBe(1);
    expect(result.data.llmCategorized).toBe(0);
    expect(result.data.categorized).toBe(1); // only the rule match
    expect(result.data.message).toContain('routed for human review');

    // Guardrail: the transaction's category is untouched
    const after = getTransactions(db);
    const stillUncategorized = after.find(t => t.description === 'Unknown Vendor');
    expect(stillUncategorized!.category).toBeNull();
    expect(stillUncategorized!.category_confidence).toBeNull();

    // Exactly one pending review entry carrying the suggestion
    const queue = getPendingCategorizationReviews(db);
    expect(queue.length).toBe(1);
    expect(queue[0].transaction_id).toBe(unknownTxn!.id);
    expect(queue[0].suggested_category).toBe('Other');
    expect(queue[0].confidence).toBe(0.6);
    expect(queue[0].status).toBe('pending');
  });

  test('re-running categorize does not duplicate pending review rows', async () => {
    insertTransactions(db, [
      { date: '2026-02-15', description: 'Mystery Store', amount: -50 },
    ]);
    initCategorizeTool(db);

    const txns = getTransactions(db);
    llmSpy.mockResolvedValue({
      response: {
        content: '',
        structured: {
          transactions: [{ id: txns[0].id, category: 'Other', confidence: 0.6 }],
        },
      },
      metadata: {},
    });

    await categorizeTool.func({});
    await categorizeTool.func({});

    expect(countPendingCategorizationReviews(db)).toBe(1);
    const queue = getPendingCategorizationReviews(db);
    expect(queue.length).toBe(1);
    expect(queue[0].transaction_id).toBe(txns[0].id);
  });

  test('above-threshold suggestion clears a stale pending review row', async () => {
    insertTransactions(db, [
      { date: '2026-02-15', description: 'Mystery Store', amount: -50 },
    ]);
    initCategorizeTool(db);

    const txns = getTransactions(db);

    // Run 1: low confidence → pending review row
    llmSpy.mockResolvedValue({
      response: {
        content: '',
        structured: {
          transactions: [{ id: txns[0].id, category: 'Other', confidence: 0.6 }],
        },
      },
      metadata: {},
    });
    await categorizeTool.func({});
    expect(countPendingCategorizationReviews(db)).toBe(1);

    // Run 2: confident suggestion → applied, stale pending row removed
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
    expect(result.data.llmCategorized).toBe(1);
    expect(result.data.routedForReview).toBe(0);

    const after = getTransactions(db);
    expect(after[0].category).toBe('Shopping');
    expect(countPendingCategorizationReviews(db)).toBe(0);
  });

  test('rule match clears a stale pending review row', async () => {
    insertTransactions(db, [
      { date: '2026-02-15', description: 'AMAZON PURCHASE', amount: -50 },
    ]);
    initCategorizeTool(db);
    const txns = getTransactions(db);

    // Simulate an earlier below-threshold suggestion awaiting review
    addPendingCategorizationReview(db, txns[0].id, 'Other', 0.6);
    expect(countPendingCategorizationReviews(db)).toBe(1);

    addRule(db, '*AMAZON*', 'Shopping');
    await categorizeTool.func({});

    const after = getTransactions(db);
    expect(after[0].category).toBe('Shopping');
    expect(countPendingCategorizationReviews(db)).toBe(0);
  });

  test('threshold override from settings gates applying', async () => {
    // Raise the bar above the mocked 0.6 confidence… and below it in the other case
    setSetting(CATEGORIZATION_CONFIDENCE_THRESHOLD_KEY, 0.5);
    try {
      insertTransactions(db, [
        { date: '2026-02-15', description: 'Mystery Store', amount: -50 },
      ]);
      initCategorizeTool(db);
      const txns = getTransactions(db);
      llmSpy.mockResolvedValue({
        response: {
          content: '',
          structured: {
            transactions: [{ id: txns[0].id, category: 'Shopping', confidence: 0.6 }],
          },
        },
        metadata: {},
      });

      const raw = await categorizeTool.func({});
      const result = JSON.parse(raw as string);
      // 0.6 >= 0.5 → applied exactly as before
      expect(result.data.routedForReview).toBe(0);
      expect(result.data.llmCategorized).toBe(1);
      expect(getTransactions(db)[0].category).toBe('Shopping');
    } finally {
      // Tests in this file share the profile's settings.json — restore the default
      setSetting(CATEGORIZATION_CONFIDENCE_THRESHOLD_KEY, DEFAULT_CATEGORIZATION_CONFIDENCE_THRESHOLD);
    }
  });

  test('raised threshold routes suggestions that would pass the default', async () => {
    setSetting(CATEGORIZATION_CONFIDENCE_THRESHOLD_KEY, 0.85);
    try {
      insertTransactions(db, [
        { date: '2026-02-15', description: 'Mystery Store', amount: -50 },
      ]);
      initCategorizeTool(db);
      const txns = getTransactions(db);
      llmSpy.mockResolvedValue({
        response: {
          content: '',
          structured: {
            transactions: [{ id: txns[0].id, category: 'Shopping', confidence: 0.8 }],
          },
        },
        metadata: {},
      });

      const raw = await categorizeTool.func({});
      const result = JSON.parse(raw as string);
      expect(result.data.routedForReview).toBe(1);
      expect(result.data.llmCategorized).toBe(0);
      expect(getTransactions(db)[0].category).toBeNull();
      expect(countPendingCategorizationReviews(db)).toBe(1);
    } finally {
      setSetting(CATEGORIZATION_CONFIDENCE_THRESHOLD_KEY, DEFAULT_CATEGORIZATION_CONFIDENCE_THRESHOLD);
    }
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
