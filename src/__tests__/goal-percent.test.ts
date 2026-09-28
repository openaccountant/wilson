import { describe, expect, test, beforeEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { initGoalManageTool, goalManageTool } from '../tools/goals/goal-manage.js';
import { buildGoalContext, initGoalContext } from '../agent/prompts.js';
import { createTestDb, currentMonthStart } from './helpers.js';
import { insertTransactions } from '../db/queries.js';

/**
 * Date inside the current month, safe even when the test runs on the 1st
 * (unlike daysAgo(N), which can fall into the previous month).
 */
function thisMonth(day: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), Math.min(day, now.getDate()));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Seed $2000 income and $600 expenses, all dated inside the current month. */
function seedCurrentMonth(db: Database): void {
  insertTransactions(db, [
    { date: thisMonth(1), description: 'Paycheck', amount: 2000.0, category: 'Income' },
    { date: thisMonth(1), description: 'Grocery Store', amount: -350.0, category: 'Groceries' },
    { date: thisMonth(1), description: 'Electric Company', amount: -250.0, category: 'Utilities' },
  ]);
}

describe('goal_manage percentage-of-income targets', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    initGoalManageTool(db);
  });

  test('migration v22 adds target_percent / income_period / resolved_target columns', () => {
    const goalCols = (db.pragma('table_info(goals)') as { name: string }[]).map((c) => c.name);
    expect(goalCols).toContain('target_percent');
    expect(goalCols).toContain('income_period');
    const snapCols = (db.pragma('table_info(goal_snapshots)') as { name: string }[]).map((c) => c.name);
    expect(snapCols).toContain('resolved_target');
  });

  test('add financial goal with targetPercent stores percent, no amount, default month period', async () => {
    const raw = await goalManageTool.func({
      action: 'add',
      title: 'Save 10%',
      goalType: 'financial',
      targetPercent: 10,
    });
    const result = JSON.parse(raw as string);
    expect(result.data.error).toBeUndefined();

    const row = db.prepare('SELECT * FROM goals WHERE id = @id').get({ id: result.data.goal.id }) as Record<string, unknown>;
    expect(row.target_amount).toBeNull();
    expect(row.target_percent).toBe(10);
    expect(row.income_period).toBe('month');
  });

  test('add honors incomePeriod when given', async () => {
    const raw = await goalManageTool.func({
      action: 'add',
      title: 'Save 10% quarterly',
      goalType: 'financial',
      targetPercent: 10,
      incomePeriod: 'quarter',
    });
    const result = JSON.parse(raw as string);
    const row = db.prepare('SELECT * FROM goals WHERE id = @id').get({ id: result.data.goal.id }) as Record<string, unknown>;
    expect(row.income_period).toBe('quarter');
  });

  test('add rejects invalid target combinations', async () => {
    const cases: { args: Parameters<typeof goalManageTool.func>[0]; error: string }[] = [
      {
        args: { action: 'add', title: 'Behavioral percent', goalType: 'behavioral', targetPercent: 10 },
        error: 'targetPercent is only supported on financial goals',
      },
      {
        args: { action: 'add', title: 'Both targets', goalType: 'financial', targetAmount: 500, targetPercent: 10 },
        error: 'specify either targetAmount or targetPercent, not both',
      },
      {
        args: { action: 'add', title: 'No target', goalType: 'financial' },
        error: 'financial goals need targetAmount or targetPercent',
      },
      {
        args: { action: 'add', title: 'Zero percent', goalType: 'financial', targetPercent: 0 },
        error: 'targetPercent must be greater than 0',
      },
    ];
    for (const { args, error } of cases) {
      const raw = await goalManageTool.func(args);
      const result = JSON.parse(raw as string);
      expect(result.data.error).toBe(error);
    }
    // targetPercent > 100 violates the tool's own schema (max 100), so the
    // defineTool guard rejects it before func runs instead of returning the
    // internal JSON error the cases above exercise.
    const over100 = await goalManageTool.func({
      action: 'add',
      title: 'Over 100 percent',
      goalType: 'financial',
      targetPercent: 150,
    }).then(() => null, (e: Error) => e);
    expect((over100 as Error).message).toContain('Invalid arguments for tool');
    expect((over100 as Error).message).toContain('targetPercent');
    const count = (db.prepare('SELECT COUNT(*) AS c FROM goals').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  test('progress auto-computes from period net savings and resolves target from income', async () => {
    seedCurrentMonth(db);
    const added = JSON.parse(
      (await goalManageTool.func({ action: 'add', title: 'Save 10%', goalType: 'financial', targetPercent: 10 })) as string
    );
    const goalId = added.data.goal.id;

    const raw = await goalManageTool.func({ action: 'progress', goalId });
    const result = JSON.parse(raw as string);
    // progress = 2000 income - 600 expenses = 1400; target = 2000 x 10% = 200
    expect(result.data.goal.current_amount).toBe(1400);
    expect(result.data.message).toContain('$200');
    expect(result.data.message).toContain('Target reached!');

    const row = db.prepare('SELECT * FROM goals WHERE id = @id').get({ id: goalId }) as Record<string, unknown>;
    expect(row.current_amount).toBe(1400);

    const snapshot = db.prepare('SELECT * FROM goal_snapshots WHERE goal_id = @goalId').get({ goalId }) as Record<string, unknown>;
    expect(snapshot.amount).toBe(1400);
    expect(snapshot.resolved_target).toBe(200);
  });

  test('progress with explicit currentAmount uses the supplied amount', async () => {
    seedCurrentMonth(db);
    const added = JSON.parse(
      (await goalManageTool.func({ action: 'add', title: 'Save 10%', goalType: 'financial', targetPercent: 10 })) as string
    );
    const goalId = added.data.goal.id;

    const raw = await goalManageTool.func({ action: 'progress', goalId, currentAmount: 50 });
    const result = JSON.parse(raw as string);
    expect(result.data.goal.current_amount).toBe(50);
    expect(result.data.message).not.toContain('Target reached!');

    const snapshot = db.prepare('SELECT * FROM goal_snapshots WHERE goal_id = @goalId').get({ goalId }) as Record<string, unknown>;
    expect(snapshot.amount).toBe(50);
    expect(snapshot.resolved_target).toBe(200);
  });

  test('progress on percent goal with no income reports it plainly', async () => {
    const added = JSON.parse(
      (await goalManageTool.func({ action: 'add', title: 'Save 10%', goalType: 'financial', targetPercent: 10 })) as string
    );
    const goalId = added.data.goal.id;

    const raw = await goalManageTool.func({ action: 'progress', goalId });
    const result = JSON.parse(raw as string);
    expect(result.data.goal.current_amount).toBe(0);
    expect(result.data.message).toContain('No income recorded yet');
    expect(result.data.message).toContain('target will update as income is logged');
  });

  test('update switches between percent and fixed-amount targets', async () => {
    const added = JSON.parse(
      (await goalManageTool.func({ action: 'add', title: 'Save 10%', goalType: 'financial', targetPercent: 10, incomePeriod: 'year' })) as string
    );
    const goalId = added.data.goal.id;

    // percent → fixed amount
    await goalManageTool.func({ action: 'update', goalId, targetAmount: 500 });
    let row = db.prepare('SELECT * FROM goals WHERE id = @id').get({ id: goalId }) as Record<string, unknown>;
    expect(row.target_amount).toBe(500);
    expect(row.target_percent).toBeNull();

    // fixed amount → percent (income_period defaults back to month)
    await goalManageTool.func({ action: 'update', goalId, targetPercent: 15 });
    row = db.prepare('SELECT * FROM goals WHERE id = @id').get({ id: goalId }) as Record<string, unknown>;
    expect(row.target_amount).toBeNull();
    expect(row.target_percent).toBe(15);
    expect(row.income_period).toBe('month');
  });

  test('update rejects targetPercent on a behavioral goal', async () => {
    const added = JSON.parse(
      (await goalManageTool.func({ action: 'add', title: 'Cut dining', goalType: 'behavioral', targetAmount: 200, category: 'Dining' })) as string
    );
    const goalId = added.data.goal.id;

    const raw = await goalManageTool.func({ action: 'update', goalId, targetPercent: 10 });
    const result = JSON.parse(raw as string);
    expect(result.data.error).toBe('targetPercent is only supported on financial goals');
  });

  test('list enriches percent goals with effective_target and leaves fixed goals untouched', async () => {
    seedCurrentMonth(db);
    await goalManageTool.func({ action: 'add', title: 'Save 10%', goalType: 'financial', targetPercent: 10 });
    await goalManageTool.func({ action: 'add', title: 'Vacation fund', goalType: 'financial', targetAmount: 3000 });

    const raw = await goalManageTool.func({ action: 'list' });
    const result = JSON.parse(raw as string);
    const percentGoal = result.data.goals.find((g: { title: string }) => g.title === 'Save 10%');
    const fixedGoal = result.data.goals.find((g: { title: string }) => g.title === 'Vacation fund');

    expect(percentGoal.effective_target).toBe(200); // $2000 income x 10%
    expect(percentGoal.period_income).toBe(2000);
    expect(fixedGoal.effective_target ?? null).toBeNull();
    expect(result.data.activeCount).toBe(2);
    expect(result.data.totalCount).toBe(2);
  });

  test('prompt context renders percent goals against the period income and keeps fixed goals unchanged', async () => {
    seedCurrentMonth(db);
    await goalManageTool.func({ action: 'add', title: 'Save 10%', goalType: 'financial', targetPercent: 10 });
    await goalManageTool.func({ action: 'add', title: 'Emergency fund', goalType: 'financial', targetAmount: 3000 });

    initGoalContext(db);
    const context = buildGoalContext();
    expect(context).not.toBeNull();

    const lines = (context as string).split('\n');
    const percentLine = lines.find((l) => l.includes('Save 10%'));
    const fixedLine = lines.find((l) => l.includes('Emergency fund'));

    expect(percentLine).toContain('10% of');
    expect(percentLine).toContain('income $2,000');
    expect(percentLine).toContain('$200');
    expect(percentLine).toContain('this month');

    // Fixed-dollar branch is untouched
    expect(fixedLine).toBe('Financial: "Emergency fund" — $0/$3,000 (0%)');
  });

  test('prompt context for percent goal with no income uses the fallback phrasing', async () => {
    await goalManageTool.func({ action: 'add', title: 'Save 10%', goalType: 'financial', targetPercent: 10 });
    initGoalContext(db);
    const context = buildGoalContext();
    expect(context).toContain('no income recorded for');
  });

  test('currentMonthStart helper stays within the seeded period window', () => {
    // Guard for the date math this suite depends on: the 1st of the month is
    // always >= the month window start, so seeded rows are always in-window.
    const start = currentMonthStart();
    expect(start.endsWith('-01')).toBe(true);
    expect(thisMonth(1) >= start).toBe(true);
  });
});