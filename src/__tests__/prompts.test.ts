import { describe, expect, test, beforeEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import {
  getCurrentDate,
  buildIterationPrompt,
  initDataContext,
  buildDataContext,
  initBudgetPrompt,
  buildBudgetContext,
  initAlertPrompt,
  buildAlertContext,
} from '../agent/prompts.js';
import { createTestDb, seedTestData } from './helpers.js';

describe('agent/prompts', () => {
  describe('getCurrentDate', () => {
    test('returns a formatted date string', () => {
      const date = getCurrentDate();
      // Should contain year, month name, and day
      expect(date).toMatch(/\d{4}/); // year
      expect(typeof date).toBe('string');
      expect(date.length).toBeGreaterThan(10);
    });
  });

  describe('buildIterationPrompt', () => {
    test('includes original query', () => {
      const prompt = buildIterationPrompt('What did I spend on groceries?', '');
      expect(prompt).toContain('What did I spend on groceries?');
    });

    test('includes tool results when present', () => {
      const toolResults = '### spending_summary(month=2026-02)\n{"total": 250}';
      const prompt = buildIterationPrompt('spending summary', toolResults);
      expect(prompt).toContain('Data retrieved from tool calls');
      expect(prompt).toContain('spending_summary');
    });

    test('omits tool results section when empty', () => {
      const prompt = buildIterationPrompt('hello', '');
      expect(prompt).not.toContain('Data retrieved from tool calls');
    });

    test('includes tool usage status when provided', () => {
      const prompt = buildIterationPrompt('query', '', '## Tool Usage\n- search: 2/3 calls');
      expect(prompt).toContain('Tool Usage');
      expect(prompt).toContain('search: 2/3 calls');
    });

    test('omits tool usage when null', () => {
      const prompt = buildIterationPrompt('query', '', null);
      expect(prompt).not.toContain('Tool Usage');
    });

    test('ends with continue instruction', () => {
      const prompt = buildIterationPrompt('query', '');
      expect(prompt).toContain('Continue working toward answering');
    });
  });

  describe('buildDataContext', () => {
    test('returns context after init with data', () => {
      const db = createTestDb();
      seedTestData(db);
      initDataContext(db);
      const ctx = buildDataContext();
      expect(ctx).not.toBeNull();
      expect(ctx).toContain('transactions');
    });

    test('returns context with transaction count after init', () => {
      const db = createTestDb();
      seedTestData(db);
      initDataContext(db);
      const ctx = buildDataContext();
      expect(ctx).toContain('Data Context');
      expect(ctx).toContain('transactions');
    });

    test('indicates empty DB when no transactions', () => {
      const db = createTestDb();
      initDataContext(db);
      const ctx = buildDataContext();
      expect(ctx).toContain('No transactions');
    });
  });

  describe('buildBudgetContext', () => {
    let db: Database;

    beforeEach(() => {
      db = createTestDb();
      seedTestData(db);
      initBudgetPrompt(db);
    });

    test('returns budget summary when budgets configured', () => {
      const ctx = buildBudgetContext();
      expect(ctx).toContain('Current Budgets');
    });

    test('returns null when no budgets', () => {
      const emptyDb = createTestDb();
      initBudgetPrompt(emptyDb);
      const ctx = buildBudgetContext();
      expect(ctx).toBeNull();
    });
  });

  describe('buildAlertContext', () => {
    test('returns null when no alerts', () => {
      const db = createTestDb();
      initAlertPrompt(db);
      const ctx = buildAlertContext();
      expect(ctx).toBeNull();
    });
  });
});
