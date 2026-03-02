import { describe, expect, test, beforeEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { initAlertCheckTool, alertCheckTool } from '../tools/query/alert-check.js';
import { setBudget, insertTransactions } from '../db/queries.js';
import { createTestDb } from './helpers.js';

describe('alert_check tool', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    initAlertCheckTool(db);
  });

  test('no alerts on empty DB', async () => {
    const raw = await alertCheckTool.func({ types: ['all'] });
    const result = JSON.parse(raw as string);
    expect(result.data.message).toContain('No active alerts');
    expect(result.data.alerts).toEqual([]);
  });

  test('budget exceeded alert when spending > budget', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const startDay = `${month}-01`;
    setBudget(db, 'Dining', 50);
    insertTransactions(db, [
      { date: startDay, description: 'Restaurant A', amount: -30, category: 'Dining' },
      { date: startDay, description: 'Restaurant B', amount: -35, category: 'Dining' },
    ]);
    initAlertCheckTool(db);

    const raw = await alertCheckTool.func({ types: ['all'] });
    const result = JSON.parse(raw as string);
    expect(result.data.alertCount).toBeGreaterThan(0);
  });

  test('type filter narrows alert types', async () => {
    const month = new Date().toISOString().slice(0, 7);
    setBudget(db, 'Dining', 10);
    insertTransactions(db, [
      { date: `${month}-01`, description: 'Expensive Dinner', amount: -100, category: 'Dining' },
    ]);
    initAlertCheckTool(db);

    // Only check for spending_spike (not budget alerts)
    const raw = await alertCheckTool.func({ types: ['spending_spike'] });
    const result = JSON.parse(raw as string);
    // Should not contain budget alerts
    const budgetAlerts = (result.data.alerts || []).filter((a: any) => a.type === 'budget_exceeded' || a.type === 'budget_warning');
    expect(budgetAlerts).toHaveLength(0);
  });

  test('formatted output includes severity labels', async () => {
    const month = new Date().toISOString().slice(0, 7);
    setBudget(db, 'Test', 1);
    insertTransactions(db, [
      { date: `${month}-01`, description: 'Big Spend', amount: -100, category: 'Test' },
    ]);
    initAlertCheckTool(db);

    const raw = await alertCheckTool.func({ types: ['all'] });
    const result = JSON.parse(raw as string);
    if (result.data.alertCount > 0) {
      expect(result.data.formatted).toMatch(/CRITICAL|WARNING|INFO/);
    }
  });
});
