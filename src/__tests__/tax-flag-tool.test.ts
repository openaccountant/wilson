import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { initTaxFlagTool, taxFlagTool } from '../tools/tax/tax-flag.js';
import { insertTransactions, getTransactions } from '../db/queries.js';
import { createTestDb } from './helpers.js';
import * as licenseModule from '../licensing/license.js';

describe('tax_flag tool', () => {
  let db: Database;
  let licenseSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    db = createTestDb();
    insertTransactions(db, [
      { date: '2026-02-15', description: 'Office Supplies', amount: -50, category: 'Shopping' },
      { date: '2026-02-18', description: 'Business Lunch', amount: -30, category: 'Dining' },
    ]);
    initTaxFlagTool(db);
    // Mock hasLicense to return true
    licenseSpy = spyOn(licenseModule, 'hasLicense').mockReturnValue(true);
  });

  afterEach(() => {
    licenseSpy.mockRestore();
  });

  test('flag action marks transaction as tax deductible', async () => {
    const txns = getTransactions(db);
    const raw = await taxFlagTool.func({
      action: 'flag',
      transactionId: txns[0].id,
      irsCategory: 'Office expense',
      taxYear: 2026,
    });
    const result = JSON.parse(raw as string);
    expect(result.data.message).toContain('flagged');
    expect(result.data.message).toContain('Office expense');
  });

  test('unflag action removes deduction', async () => {
    const txns = getTransactions(db);
    await taxFlagTool.func({ action: 'flag', transactionId: txns[0].id, irsCategory: 'Supplies', taxYear: 2026 });

    const raw = await taxFlagTool.func({ action: 'unflag', transactionId: txns[0].id });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
  });

  test('summary returns deduction totals by category', async () => {
    const txns = getTransactions(db);
    await taxFlagTool.func({ action: 'flag', transactionId: txns[0].id, irsCategory: 'Office expense', taxYear: 2026 });
    await taxFlagTool.func({ action: 'flag', transactionId: txns[1].id, irsCategory: 'Meals (business)', taxYear: 2026 });

    const raw = await taxFlagTool.func({ action: 'summary', taxYear: 2026 });
    const result = JSON.parse(raw as string);
    expect(result.data.summary.length).toBe(2);
  });

  test('list returns individual deductions', async () => {
    const txns = getTransactions(db);
    await taxFlagTool.func({ action: 'flag', transactionId: txns[0].id, irsCategory: 'Supplies', taxYear: 2026 });

    const raw = await taxFlagTool.func({ action: 'list', taxYear: 2026 });
    const result = JSON.parse(raw as string);
    expect(result.data.deductions.length).toBe(1);
  });

  test('invalid IRS category returns error', async () => {
    const txns = getTransactions(db);
    const raw = await taxFlagTool.func({
      action: 'flag',
      transactionId: txns[0].id,
      irsCategory: 'Invalid Category',
      taxYear: 2026,
    });
    const result = JSON.parse(raw as string);
    expect(result.data.error).toContain('Invalid IRS category');
  });

  test('no license returns error', async () => {
    licenseSpy.mockReturnValue(false);
    const raw = await taxFlagTool.func({ action: 'summary', taxYear: 2026 });
    const result = JSON.parse(raw as string);
    expect(result.data.error).toContain('Pro feature');
  });
});
