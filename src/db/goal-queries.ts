import type { Database } from './compat-sqlite.js';
import { getProfitLoss } from './queries.js';

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface GoalRow {
  id: number;
  title: string;
  goal_type: 'financial' | 'behavioral';
  target_amount: number | null;
  target_percent: number | null;
  income_period: string | null;
  current_amount: number;
  target_date: string | null;
  category: string | null;
  account_id: number | null;
  status: 'active' | 'completed' | 'paused' | 'abandoned';
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoalSnapshotRow {
  id: number;
  goal_id: number;
  amount: number;
  resolved_target: number | null;
  snapshot_date: string;
  created_at: string;
}

export type IncomePeriod = 'month' | 'quarter' | 'year';

export interface GoalInsert {
  title: string;
  goalType: 'financial' | 'behavioral';
  targetAmount?: number;
  targetPercent?: number;
  incomePeriod?: IncomePeriod;
  targetDate?: string;
  category?: string;
  accountId?: number;
  notes?: string;
}

export interface GoalUpdate {
  title?: string;
  targetAmount?: number;
  targetPercent?: number;
  incomePeriod?: IncomePeriod;
  targetDate?: string;
  category?: string;
  accountId?: number;
  notes?: string;
}

// ── Queries ───────────────────────────────────────────────────────────────────

export function getActiveGoals(db: Database): GoalRow[] {
  return db.prepare(`
    SELECT * FROM goals WHERE status = 'active' ORDER BY created_at DESC
  `).all() as GoalRow[];
}

export function getGoalById(db: Database, id: number): (GoalRow & { latest_snapshot?: GoalSnapshotRow }) | undefined {
  const goal = db.prepare('SELECT * FROM goals WHERE id = @id').get({ id }) as GoalRow | undefined;
  if (!goal) return undefined;

  const snapshot = db.prepare(`
    SELECT * FROM goal_snapshots WHERE goal_id = @id ORDER BY snapshot_date DESC LIMIT 1
  `).get({ id }) as GoalSnapshotRow | undefined;

  return { ...goal, latest_snapshot: snapshot };
}

export function upsertGoal(db: Database, goal: GoalInsert & { id?: number }): number {
  if (goal.id) {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id: goal.id };

    if (goal.title !== undefined) { sets.push('title = @title'); params.title = goal.title; }
    if (goal.targetAmount !== undefined) {
      sets.push('target_amount = @targetAmount');
      params.targetAmount = goal.targetAmount;
      // Financial goals carry either a fixed amount or a percent — passing one
      // redefines the target and clears the other.
      sets.push('target_percent = NULL');
    }
    if (goal.targetPercent !== undefined) {
      sets.push('target_percent = @targetPercent');
      params.targetPercent = goal.targetPercent;
      sets.push('target_amount = NULL');
      sets.push(`income_period = ${goal.incomePeriod !== undefined ? '@incomePeriod' : "'month'"}`);
      if (goal.incomePeriod !== undefined) params.incomePeriod = goal.incomePeriod;
    } else if (goal.incomePeriod !== undefined) {
      sets.push('income_period = @incomePeriod');
      params.incomePeriod = goal.incomePeriod;
    }
    if (goal.targetDate !== undefined) { sets.push('target_date = @targetDate'); params.targetDate = goal.targetDate; }
    if (goal.category !== undefined) { sets.push('category = @category'); params.category = goal.category; }
    if (goal.accountId !== undefined) { sets.push('account_id = @accountId'); params.accountId = goal.accountId; }
    if (goal.notes !== undefined) { sets.push('notes = @notes'); params.notes = goal.notes; }

    if (sets.length > 0) {
      sets.push("updated_at = datetime('now')");
      db.prepare(`UPDATE goals SET ${sets.join(', ')} WHERE id = @id`).run(params);
    }
    return goal.id;
  }

  const result = db.prepare(`
    INSERT INTO goals (title, goal_type, target_amount, target_percent, income_period, target_date, category, account_id, notes)
    VALUES (@title, @goalType, @targetAmount, @targetPercent, @incomePeriod, @targetDate, @category, @accountId, @notes)
  `).run({
    title: goal.title,
    goalType: goal.goalType,
    targetAmount: goal.targetAmount ?? null,
    targetPercent: goal.targetPercent ?? null,
    // A percent goal always has a period basis — default to monthly.
    incomePeriod: goal.incomePeriod ?? (goal.targetPercent !== undefined ? 'month' : null),
    targetDate: goal.targetDate ?? null,
    category: goal.category ?? null,
    accountId: goal.accountId ?? null,
    notes: goal.notes ?? null,
  });
  return (result as { lastInsertRowid: number }).lastInsertRowid;
}

export function updateGoalProgress(db: Database, goalId: number, amount: number, resolvedTarget?: number): void {
  db.prepare(`
    UPDATE goals SET current_amount = @amount, updated_at = datetime('now') WHERE id = @goalId
  `).run({ goalId, amount });

  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO goal_snapshots (goal_id, amount, resolved_target, snapshot_date)
    VALUES (@goalId, @amount, @resolvedTarget, @today)
    ON CONFLICT(goal_id, snapshot_date) DO UPDATE SET amount = @amount, resolved_target = @resolvedTarget
  `).run({ goalId, amount, resolvedTarget: resolvedTarget ?? null, today });
}

export function updateGoalStatus(db: Database, goalId: number, status: GoalRow['status']): void {
  db.prepare(`
    UPDATE goals SET status = @status, updated_at = datetime('now') WHERE id = @goalId
  `).run({ goalId, status });
}

export function getGoalSnapshots(db: Database, goalId: number, months?: number): GoalSnapshotRow[] {
  if (months) {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    return db.prepare(`
      SELECT * FROM goal_snapshots
      WHERE goal_id = @goalId AND snapshot_date >= @cutoffDate
      ORDER BY snapshot_date ASC
    `).all({ goalId, cutoffDate }) as GoalSnapshotRow[];
  }
  return db.prepare(`
    SELECT * FROM goal_snapshots WHERE goal_id = @goalId ORDER BY snapshot_date ASC
  `).all({ goalId }) as GoalSnapshotRow[];
}

export function getAllGoals(db: Database): GoalRow[] {
  return db.prepare('SELECT * FROM goals ORDER BY status ASC, created_at DESC').all() as GoalRow[];
}

// ── Percentage-of-income target resolution ───────────────────────────────────

export interface PeriodWindow {
  start: string;
  end: string;
  label: string;
}

export interface ResolvedGoalTarget extends PeriodWindow {
  /** Total income for the period window (from getProfitLoss). */
  income: number;
  /** income × target_percent / 100, rounded to cents. */
  target: number;
  /** Net savings for the window (income + expenses, expenses negative). */
  progress: number;
}

/**
 * Compute the start/end dates and label for a month, quarter, or year window.
 * Local date math — mirrors getPeriodDates in the spending-summary tool, but
 * lives here so db code never imports from the tools layer.
 */
export function getPeriodWindow(period: IncomePeriod, offset = 0): PeriodWindow {
  const now = new Date();
  let start: Date;
  let end: Date;
  let label: string;

  switch (period) {
    case 'month': {
      const targetMonth = now.getMonth() + offset;
      start = new Date(now.getFullYear(), targetMonth, 1);
      end = new Date(now.getFullYear(), targetMonth + 1, 0); // last day of month
      label = start.toLocaleString('en-US', { month: 'long', year: 'numeric' });
      break;
    }
    case 'quarter': {
      const currentQuarter = Math.floor(now.getMonth() / 3);
      const targetQuarter = currentQuarter + offset;
      const qYear = now.getFullYear() + Math.floor(targetQuarter / 4);
      const qNum = ((targetQuarter % 4) + 4) % 4;
      start = new Date(qYear, qNum * 3, 1);
      end = new Date(qYear, qNum * 3 + 3, 0);
      label = `Q${qNum + 1} ${qYear}`;
      break;
    }
    case 'year': {
      const targetYear = now.getFullYear() + offset;
      start = new Date(targetYear, 0, 1);
      end = new Date(targetYear, 11, 31);
      label = String(targetYear);
      break;
    }
  }

  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  return { start: fmt(start), end: fmt(end), label };
}

/**
 * Resolve the effective dollar target for a percentage-of-income goal.
 *
 * The target for the current period is `totalIncome(period) × target_percent / 100`,
 * computed from real transaction data, so it moves as income changes. Progress for
 * the period is the period's net savings. Returns null for fixed-amount goals
 * (target_percent is null).
 */
export function resolveGoalTarget(db: Database, goal: GoalRow): ResolvedGoalTarget | null {
  if (goal.target_percent == null) return null;

  const period = (goal.income_period ?? 'month') as IncomePeriod;
  const window = getPeriodWindow(period, 0);
  const pnl = getProfitLoss(db, window.start, window.end);

  return {
    ...window,
    income: pnl.totalIncome,
    target: Math.round(pnl.totalIncome * goal.target_percent) / 100,
    progress: pnl.totalIncome + pnl.totalExpenses,
  };
}
