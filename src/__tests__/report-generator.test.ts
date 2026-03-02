import { describe, expect, test, beforeEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { generateReport } from '../report/generator.js';
import { createTestDb, seedTestData } from './helpers.js';

describe('generateReport', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
  });

  test('generates report with all sections', () => {
    const report = generateReport(db, '2026-02');
    expect(report).toContain('Financial Report');
    expect(report).toContain('## Summary');
    expect(report).toContain('## Spending by Category');
    expect(report).toContain('## Budget vs Actual');
    expect(report).toContain('## Savings Rate');
    expect(report).toContain('## Recent Transactions');
  });

  test('selective sections only includes requested', () => {
    const report = generateReport(db, '2026-02', ['summary', 'spending']);
    expect(report).toContain('## Summary');
    expect(report).toContain('## Spending by Category');
    expect(report).not.toContain('## Budget vs Actual');
  });

  test('month label appears in header', () => {
    const report = generateReport(db, '2026-02');
    expect(report).toContain('February 2026');
  });

  test('generated date is present', () => {
    const report = generateReport(db, '2026-02');
    expect(report).toContain('Generated:');
  });

  test('summary section shows income and expenses', () => {
    const report = generateReport(db, '2026-02');
    expect(report).toContain('Total Income');
    expect(report).toContain('Total Expenses');
  });

  test('empty DB generates graceful report', () => {
    const emptyDb = createTestDb();
    const report = generateReport(emptyDb, '2026-02');
    expect(report).toContain('Financial Report');
    expect(report).toContain('No spending data');
  });

  test('budget section shows configured budgets', () => {
    const report = generateReport(db, '2026-02');
    expect(report).toContain('Groceries');
    expect(report).toContain('Dining');
  });

  test('"all" section flag includes everything', () => {
    const report = generateReport(db, '2026-02', ['all']);
    expect(report).toContain('## Summary');
    expect(report).toContain('## Spending by Category');
  });
});
