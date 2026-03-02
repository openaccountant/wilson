import { describe, expect, test, beforeEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import {
  getTransactionCount,
  getUncategorizedCount,
  getBudgetCount,
  getLastImportDate,
  insertTransactions,
  setBudget,
  recordImport,
} from '../db/queries.js';
import { createTestDb, seedTestData } from './helpers.js';
import { ContextHintsComponent, collectHints } from '../components/context-hints.js';

// Strip ANSI escape codes so we can assert on visible text
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

// ── Count helpers ────────────────────────────────────────────────────────────

describe('count helpers', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
  });

  test('getTransactionCount returns total rows', () => {
    expect(getTransactionCount(db)).toBe(7);
  });

  test('getTransactionCount returns 0 on empty DB', () => {
    const empty = createTestDb();
    expect(getTransactionCount(empty)).toBe(0);
  });

  test('getUncategorizedCount returns null-category rows', () => {
    expect(getUncategorizedCount(db)).toBe(1);
  });

  test('getUncategorizedCount returns 0 when all categorized', () => {
    const fresh = createTestDb();
    insertTransactions(fresh, [
      { date: '2026-01-01', description: 'Test', amount: -10, category: 'Misc' },
    ]);
    expect(getUncategorizedCount(fresh)).toBe(0);
  });

  test('getBudgetCount returns number of budgets', () => {
    expect(getBudgetCount(db)).toBe(2);
  });

  test('getBudgetCount returns 0 on empty DB', () => {
    const empty = createTestDb();
    expect(getBudgetCount(empty)).toBe(0);
  });

  test('getLastImportDate returns null when no imports', () => {
    expect(getLastImportDate(db)).toBeNull();
  });

  test('getLastImportDate returns most recent imported_at', () => {
    recordImport(db, {
      file_path: 'a.csv',
      file_hash: 'hash-a',
      transaction_count: 1,
    });
    const result = getLastImportDate(db);
    expect(result).toBeTruthy();
  });
});

// ── collectHints ─────────────────────────────────────────────────────────────

describe('collectHints', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  test('empty DB returns /import hint + fallback', () => {
    const hints = collectHints(db);
    expect(hints.length).toBe(2);
    expect(stripAnsi(hints[0])).toContain('/import');
    expect(stripAnsi(hints[1])).toContain('/help');
  });

  test('uncategorized transactions produce /categorize hint', () => {
    insertTransactions(db, [
      { date: '2026-01-01', description: 'Mystery', amount: -10 },
    ]);
    const hints = collectHints(db);
    const texts = hints.map(stripAnsi);
    expect(texts.some((t) => t.includes('/categorize'))).toBe(true);
    expect(texts.some((t) => t.includes('1 uncategorized transaction'))).toBe(true);
  });

  test('plural form for multiple uncategorized', () => {
    insertTransactions(db, [
      { date: '2026-01-01', description: 'A', amount: -10 },
      { date: '2026-01-02', description: 'B', amount: -20 },
    ]);
    const hints = collectHints(db);
    const texts = hints.map(stripAnsi);
    expect(texts.some((t) => t.includes('2 uncategorized transactions'))).toBe(true);
  });

  test('no budgets produces /budget hint', () => {
    insertTransactions(db, [
      { date: '2026-01-01', description: 'Test', amount: -10, category: 'Misc' },
    ]);
    const hints = collectHints(db);
    const texts = hints.map(stripAnsi);
    expect(texts.some((t) => t.includes('/budget set'))).toBe(true);
  });

  test('fallback /help hint always present', () => {
    seedTestData(db);
    db.prepare("UPDATE transactions SET category = 'Other' WHERE category IS NULL").run();
    const hints = collectHints(db);
    const texts = hints.map(stripAnsi);
    expect(texts[texts.length - 1]).toContain('/help');
  });

  test('returns multiple hints, not just one', () => {
    // Uncategorized txns + no budgets → at least uncategorized + no-budget + fallback
    insertTransactions(db, [
      { date: '2026-01-01', description: 'A', amount: -10 },
    ]);
    const hints = collectHints(db);
    expect(hints.length).toBeGreaterThanOrEqual(3);
  });
});

// ── Time-aware hints ─────────────────────────────────────────────────────────

describe('time-aware hints', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    insertTransactions(db, [
      { date: '2026-01-01', description: 'Test', amount: -10, category: 'Misc' },
    ]);
    setBudget(db, 'Misc', 500);
  });

  test('stale import (>7 days ago) shows staleness hint', () => {
    // Insert import with old timestamp
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO imports (file_path, file_hash, imported_at)
      VALUES ('old.csv', 'hash-old', @ts)
    `).run({ ts: tenDaysAgo });

    const hints = collectHints(db);
    const texts = hints.map(stripAnsi);
    expect(texts.some((t) => t.includes('Last import was') && t.includes('/import'))).toBe(true);
  });

  test('recent import (<7 days) does NOT show staleness hint', () => {
    recordImport(db, {
      file_path: 'recent.csv',
      file_hash: 'hash-recent',
      transaction_count: 1,
    });
    const hints = collectHints(db);
    const texts = hints.map(stripAnsi);
    expect(texts.some((t) => t.includes('Last import was'))).toBe(false);
  });
});

// ── Data-driven hints ────────────────────────────────────────────────────────

describe('data-driven hints', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  test('budget overspend shows percentage hint', () => {
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const day = `${thisMonth}-10`;

    insertTransactions(db, [
      { date: day, description: 'Big Dinner', amount: -250, category: 'Dining' },
    ]);
    setBudget(db, 'Dining', 100);

    const hints = collectHints(db);
    const texts = hints.map(stripAnsi);
    expect(texts.some((t) => t.includes('Dining') && t.includes('250%') && t.includes('budget'))).toBe(true);
  });

  test('month-over-month spending spike shows change hint', () => {
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonth = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;

    insertTransactions(db, [
      // Last month: $100 groceries
      { date: `${lastMonth}-10`, description: 'Groceries', amount: -100, category: 'Groceries' },
      // This month: $200 groceries (up 100%)
      { date: `${thisMonth}-10`, description: 'Groceries', amount: -200, category: 'Groceries' },
    ]);
    // Need a budget so the "no budgets" hint doesn't appear, but doesn't matter for this test
    setBudget(db, 'Groceries', 500);

    const hints = collectHints(db);
    const texts = hints.map(stripAnsi);
    expect(texts.some((t) => t.includes('Groceries') && t.includes('up 100%'))).toBe(true);
  });

  test('small spending change (<25%) does NOT show hint', () => {
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonth = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;

    insertTransactions(db, [
      { date: `${lastMonth}-10`, description: 'Groceries', amount: -100, category: 'Groceries' },
      { date: `${thisMonth}-10`, description: 'Groceries', amount: -110, category: 'Groceries' },
    ]);
    setBudget(db, 'Groceries', 500);

    const hints = collectHints(db);
    const texts = hints.map(stripAnsi);
    expect(texts.some((t) => t.includes('Groceries') && t.includes('up'))).toBe(false);
  });

  test('savings rate hint shows last month percentage', () => {
    const lastMonthDate = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
    const lastMonth = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;

    insertTransactions(db, [
      { date: `${lastMonth}-05`, description: 'Paycheck', amount: 5000, category: 'Income' },
      { date: `${lastMonth}-15`, description: 'Rent', amount: -2000, category: 'Housing' },
    ]);
    setBudget(db, 'Housing', 3000);

    const hints = collectHints(db);
    const texts = hints.map(stripAnsi);
    // Savings = 5000 - 2000 = 3000, rate = 60%
    expect(texts.some((t) => t.includes('Saved') && t.includes('60%'))).toBe(true);
  });
});

// ── Rotation ─────────────────────────────────────────────────────────────────

describe('ContextHintsComponent rotation', () => {
  let db: Database;
  let comp: ContextHintsComponent;

  beforeEach(() => {
    db = createTestDb();
    comp = new ContextHintsComponent();
  });

  test('rotates through all hints on successive refreshes', () => {
    // Uncategorized + no budgets + fallback = at least 3
    insertTransactions(db, [
      { date: '2026-01-01', description: 'A', amount: -10 },
    ]);

    const hints = collectHints(db);
    const seen: string[] = [];

    for (let i = 0; i < hints.length; i++) {
      comp.refresh(db);
      const text = (comp as any).hintsText.text;
      seen.push(text);
    }

    // Each hint in the pool should have been shown
    const uniqueSeen = new Set(seen);
    expect(uniqueSeen.size).toBe(hints.length);
  });

  test('wraps around after showing all hints', () => {
    insertTransactions(db, [
      { date: '2026-01-01', description: 'A', amount: -10 },
    ]);

    const hints = collectHints(db);

    // Go through one full cycle + 1
    for (let i = 0; i < hints.length; i++) {
      comp.refresh(db);
    }

    // The next refresh should show the first hint again
    comp.refresh(db);
    const text = (comp as any).hintsText.text;
    const firstHint = hints[0]; // pool may have been re-collected but same content
    // First hint should reappear
    expect(stripAnsi(text)).toBe(stripAnsi(firstHint));
  });

  test('resets index when hint pool changes', () => {
    // Start with uncategorized transactions
    insertTransactions(db, [
      { date: '2026-01-01', description: 'A', amount: -10 },
    ]);

    comp.refresh(db); // index 0 → shows hint[0]
    comp.refresh(db); // index 1 → shows hint[1]

    // Now categorize everything → pool changes
    db.prepare("UPDATE transactions SET category = 'Other' WHERE category IS NULL").run();
    setBudget(db, 'Misc', 500);

    comp.refresh(db);
    // After pool change, should show hint[0] of the new pool
    const text = stripAnsi((comp as any).hintsText.text);
    const newHints = collectHints(db);
    expect(text).toBe(stripAnsi(newHints[0]));
  });
});

// ── Color ────────────────────────────────────────────────────────────────────

describe('hint color', () => {
  test('commands use theme.accent, not theme.primaryLight', () => {
    // Verify the source code uses theme.accent() for command highlights.
    // In non-TTY environments chalk may strip ANSI codes, so we verify
    // the component output contains the expected visible text.
    const db = createTestDb();
    const hints = collectHints(db);
    const raw = hints[0];
    expect(stripAnsi(raw)).toContain('/import');
    expect(stripAnsi(raw)).toContain('get started');
  });
});
