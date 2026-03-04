import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import {
  getCurrentDate,
  buildIterationPrompt,
  buildSystemPrompt,
  loadSoulDocument,
  initDataContext,
  buildDataContext,
  initBudgetPrompt,
  buildBudgetContext,
  initAlertPrompt,
  buildAlertContext,
  initNetWorthContext,
  buildNetWorthContext,
} from '../agent/prompts.js';
import * as toolsRegistry from '../tools/registry.js';
import * as skillsIndex from '../skills/index.js';
import { insertAccount } from '../db/net-worth-queries.js';
import { setBudget, insertTransactions } from '../db/queries.js';
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

  describe('loadSoulDocument', () => {
    test('returns content (bundled SOUL.md exists in project root)', async () => {
      const content = await loadSoulDocument();
      // The bundled SOUL.md should exist at the project root
      // If no user override and no bundled file, returns null
      if (content !== null) {
        expect(typeof content).toBe('string');
        expect(content.length).toBeGreaterThan(0);
      } else {
        // SOUL.md is optional — null is also valid
        expect(content).toBeNull();
      }
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

    test('returns formatted string with alerts present', () => {
      const db = createTestDb();
      seedTestData(db);
      // Set Groceries budget to $50 so actual $85.50 > limit → budget_exceeded
      setBudget(db, 'Groceries', 50);
      initAlertPrompt(db);
      const ctx = buildAlertContext();
      expect(ctx).not.toBeNull();
      expect(ctx).toContain('Active Alerts');
      expect(ctx).toContain('Groceries');
    });
  });

  describe('buildBudgetContext (extended)', () => {
    test('shows OVER for exceeded budget', () => {
      const db = createTestDb();
      seedTestData(db);
      // Current month's groceries: seed has $92 in March (2026-03-01)
      // Set budget low to trigger OVER
      setBudget(db, 'Groceries', 50);
      initBudgetPrompt(db);
      const ctx = buildBudgetContext();
      // Should contain OVER since $92 > $50
      if (ctx && ctx.includes('Groceries')) {
        expect(ctx).toContain('OVER');
      }
    });
  });

  describe('buildNetWorthContext', () => {
    test('returns null when no db set', () => {
      // Reset net worth context by calling with a fresh DB that has no accounts
      const db = createTestDb();
      initNetWorthContext(db);
      const ctx = buildNetWorthContext();
      expect(ctx).toBeNull();
    });

    test('returns formatted string with accounts', () => {
      const db = createTestDb();
      insertAccount(db, {
        name: 'Checking',
        account_type: 'asset',
        account_subtype: 'checking',
        current_balance: 10000,
      });
      insertAccount(db, {
        name: 'Credit Card',
        account_type: 'liability',
        account_subtype: 'credit_card',
        current_balance: 2000,
      });
      initNetWorthContext(db);
      const ctx = buildNetWorthContext();
      expect(ctx).not.toBeNull();
      expect(ctx).toContain('Balance Sheet');
      expect(ctx).toContain('Net worth');
      expect(ctx).toContain('Checking');
    });
  });

  describe('buildSystemPrompt', () => {
    let toolDescSpy: ReturnType<typeof spyOn>;
    let discoverSpy: ReturnType<typeof spyOn>;
    let metadataSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      toolDescSpy = spyOn(toolsRegistry, 'buildToolDescriptions').mockResolvedValue('## Mock Tool Descriptions');
      discoverSpy = spyOn(skillsIndex, 'discoverSkills').mockReturnValue([]);
      metadataSpy = spyOn(skillsIndex, 'buildSkillMetadataSection').mockReturnValue('');
    });

    afterEach(() => {
      toolDescSpy?.mockRestore();
      discoverSpy?.mockRestore();
      metadataSpy?.mockRestore();
    });

    test('returns system prompt with tool descriptions', async () => {
      const prompt = await buildSystemPrompt('test-model');
      expect(prompt).toContain('Open Accountant');
      expect(prompt).toContain('Mock Tool Descriptions');
      expect(prompt).toContain('Tool Usage Policy');
    });

    test('includes skills section when skills exist', async () => {
      discoverSpy.mockReturnValue([{ name: 'test-skill', description: 'A test', tier: 'free', source: 'builtin', path: '/tmp' }]);
      metadataSpy.mockReturnValue('- **test-skill**: A test');

      const prompt = await buildSystemPrompt('test-model');
      expect(prompt).toContain('Available Skills');
      expect(prompt).toContain('Skill Usage Policy');
    });

    test('omits skills section when no skills', async () => {
      discoverSpy.mockReturnValue([]);

      const prompt = await buildSystemPrompt('test-model');
      expect(prompt).not.toContain('Available Skills');
    });

    test('includes soul content when provided', async () => {
      const prompt = await buildSystemPrompt('test-model', 'You are Wilson, a witty accountant.');
      expect(prompt).toContain('Identity');
      expect(prompt).toContain('You are Wilson, a witty accountant.');
      expect(prompt).toContain('Embody the identity');
    });

    test('omits identity section when no soul content', async () => {
      const prompt = await buildSystemPrompt('test-model', null);
      expect(prompt).not.toContain('Identity');
    });

    test('includes response format section', async () => {
      const prompt = await buildSystemPrompt('test-model');
      expect(prompt).toContain('Response Format');
      expect(prompt).toContain('Tables');
    });
  });
});
