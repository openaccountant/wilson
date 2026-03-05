import type { Database } from './compat-sqlite.js';

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface GoalRow {
  id: number;
  title: string;
  goal_type: 'financial' | 'behavioral';
  target_amount: number | null;
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
  snapshot_date: string;
  created_at: string;
}

export interface GoalInsert {
  title: string;
  goalType: 'financial' | 'behavioral';
  targetAmount?: number;
  targetDate?: string;
  category?: string;
  accountId?: number;
  notes?: string;
}

export interface GoalUpdate {
  title?: string;
  targetAmount?: number;
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
    if (goal.targetAmount !== undefined) { sets.push('target_amount = @targetAmount'); params.targetAmount = goal.targetAmount; }
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
    INSERT INTO goals (title, goal_type, target_amount, target_date, category, account_id, notes)
    VALUES (@title, @goalType, @targetAmount, @targetDate, @category, @accountId, @notes)
  `).run({
    title: goal.title,
    goalType: goal.goalType,
    targetAmount: goal.targetAmount ?? null,
    targetDate: goal.targetDate ?? null,
    category: goal.category ?? null,
    accountId: goal.accountId ?? null,
    notes: goal.notes ?? null,
  });
  return (result as { lastInsertRowid: number }).lastInsertRowid;
}

export function updateGoalProgress(db: Database, goalId: number, amount: number): void {
  db.prepare(`
    UPDATE goals SET current_amount = @amount, updated_at = datetime('now') WHERE id = @goalId
  `).run({ goalId, amount });

  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO goal_snapshots (goal_id, amount, snapshot_date)
    VALUES (@goalId, @amount, @today)
    ON CONFLICT(goal_id, snapshot_date) DO UPDATE SET amount = @amount
  `).run({ goalId, amount, today });
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
