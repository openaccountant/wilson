import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import type { Database } from '../../db/compat-sqlite.js';
import {
  getActiveGoals,
  getGoalById,
  upsertGoal,
  updateGoalProgress,
  updateGoalStatus,
  getAllGoals,
  resolveGoalTarget,
} from '../../db/goal-queries.js';

let db: Database;

export function initGoalManageTool(database: Database) {
  db = database;
}

const fmtUSD = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

/**
 * Validate target-field combinations shared by the add and update actions.
 * Returns an error message, or null when the inputs are valid.
 */
function validateTargets(
  goalType: 'financial' | 'behavioral' | undefined,
  targetAmount: number | undefined,
  targetPercent: number | undefined
): string | null {
  if (targetPercent !== undefined) {
    if (targetPercent <= 0) return 'targetPercent must be greater than 0';
    if (targetPercent > 100) return 'targetPercent must be 100 or less';
    if (goalType === 'behavioral') {
      return 'targetPercent is only supported on financial goals';
    }
  }
  if (targetAmount !== undefined && targetPercent !== undefined) {
    return 'specify either targetAmount or targetPercent, not both';
  }
  if (goalType === 'financial' && targetAmount === undefined && targetPercent === undefined) {
    return 'financial goals need targetAmount or targetPercent';
  }
  return null;
}

export const goalManageTool = defineTool({
  name: 'goal_manage',
  description: 'Manage financial and behavioral goals — add, update, track progress, list, or change status. Financial goals support a fixed targetAmount or a percentage-of-income targetPercent that is computed from actual income each period.',
  schema: z.object({
    action: z.enum(['add', 'update', 'progress', 'list', 'complete', 'pause', 'abandon']).describe('Action to perform'),
    title: z.string().optional().describe('Goal title (required for add)'),
    goalType: z.enum(['financial', 'behavioral']).optional().describe('Goal type (required for add)'),
    targetAmount: z.number().optional().describe('Target amount in dollars (financial goals)'),
    targetPercent: z.number().min(0).max(100).optional().describe('Target as % of income for the period (financial goals; e.g. 10 = save 10% of income)'),
    incomePeriod: z.enum(['month', 'quarter', 'year']).optional().describe('Period the percent applies to (default month)'),
    targetDate: z.string().optional().describe('Target date (ISO format, e.g. 2026-12-31)'),
    category: z.string().optional().describe('Spending category this goal relates to'),
    accountId: z.number().optional().describe('Account ID this goal tracks'),
    goalId: z.number().optional().describe('Goal ID (required for update/progress/complete/pause/abandon)'),
    currentAmount: z.number().optional().describe('Current progress amount (for progress action; optional for percent-of-income goals, which auto-compute from period savings)'),
    notes: z.string().optional().describe('Optional notes'),
  }),
  func: async ({ action, title, goalType, targetAmount, targetPercent, incomePeriod, targetDate, category, accountId, goalId, currentAmount, notes }) => {
    switch (action) {
      case 'add': {
        if (!title || !goalType) {
          return formatToolResult({ error: 'title and goalType are required for add action' });
        }
        const targetError = validateTargets(goalType, targetAmount, targetPercent);
        if (targetError) {
          return formatToolResult({ error: targetError });
        }
        const id = upsertGoal(db, { title, goalType, targetAmount, targetPercent, incomePeriod, targetDate, category, accountId, notes });
        const goal = getGoalById(db, id);
        return formatToolResult({ message: `Goal created: "${title}"`, goal });
      }

      case 'update': {
        if (!goalId) {
          return formatToolResult({ error: 'goalId is required for update action' });
        }
        const existing = getGoalById(db, goalId);
        const effectiveType = goalType ?? existing?.goal_type ?? 'financial';
        const targetError = validateTargets(effectiveType, targetAmount, targetPercent);
        if (targetError) {
          return formatToolResult({ error: targetError });
        }
        upsertGoal(db, { id: goalId, title: title ?? '', goalType: effectiveType, targetAmount, targetPercent, incomePeriod, targetDate, category, accountId, notes });
        const goal = getGoalById(db, goalId);
        return formatToolResult({ message: `Goal #${goalId} updated`, goal });
      }

      case 'progress': {
        if (!goalId) {
          return formatToolResult({ error: 'goalId is required for progress action' });
        }
        const goal = getGoalById(db, goalId);
        if (!goal) {
          return formatToolResult({ error: `Goal #${goalId} not found` });
        }

        // Percentage-of-income goal: currentAmount is optional — progress for the
        // period defaults to the period's net savings, and the dollar target is
        // resolved from actual income for the goal's period window.
        if (goal.target_percent != null) {
          const resolved = resolveGoalTarget(db, goal);
          const amount = currentAmount ?? resolved?.progress ?? 0;
          updateGoalProgress(db, goalId, amount, resolved?.target);
          const updated = getGoalById(db, goalId);

          if (resolved && resolved.income === 0) {
            return formatToolResult({
              message: `Goal #${goalId} progress updated to ${fmtUSD(amount)}. No income recorded yet for ${resolved.label} — target will update as income is logged.`,
              goal: updated,
            });
          }
          if (resolved && amount >= resolved.target) {
            return formatToolResult({
              message: `Goal #${goalId} progress updated to ${fmtUSD(amount)} of ${fmtUSD(resolved.target)} (${goal.target_percent}% of ${resolved.label} income ${fmtUSD(resolved.income)}). Target reached!`,
              goal: updated,
            });
          }
          if (resolved) {
            return formatToolResult({
              message: `Goal #${goalId} progress updated to ${fmtUSD(amount)} of ${fmtUSD(resolved.target)} (${goal.target_percent}% of ${resolved.label} income ${fmtUSD(resolved.income)})`,
              goal: updated,
            });
          }
          return formatToolResult({ message: `Goal #${goalId} progress updated to ${fmtUSD(amount)}`, goal: updated });
        }

        if (currentAmount === undefined) {
          return formatToolResult({ error: 'goalId and currentAmount are required for progress action' });
        }
        updateGoalProgress(db, goalId, currentAmount);
        const updated = getGoalById(db, goalId);
        if (updated && updated.target_amount && currentAmount >= updated.target_amount) {
          return formatToolResult({ message: `Goal #${goalId} progress updated to $${currentAmount}. Target reached!`, goal: updated });
        }
        return formatToolResult({ message: `Goal #${goalId} progress updated to $${currentAmount}`, goal: updated });
      }

      case 'list': {
        const goals = getAllGoals(db).map((g) => {
          if (g.target_percent != null) {
            const resolved = resolveGoalTarget(db, g);
            return {
              ...g,
              effective_target: resolved?.target ?? null,
              period_income: resolved?.income ?? null,
              period_label: resolved?.label ?? null,
            };
          }
          return g;
        });
        return formatToolResult({
          goals,
          activeCount: goals.filter(g => g.status === 'active').length,
          totalCount: goals.length,
        });
      }

      case 'complete': {
        if (!goalId) {
          return formatToolResult({ error: 'goalId is required for complete action' });
        }
        updateGoalStatus(db, goalId, 'completed');
        return formatToolResult({ message: `Goal #${goalId} marked as completed` });
      }

      case 'pause': {
        if (!goalId) {
          return formatToolResult({ error: 'goalId is required for pause action' });
        }
        updateGoalStatus(db, goalId, 'paused');
        return formatToolResult({ message: `Goal #${goalId} paused` });
      }

      case 'abandon': {
        if (!goalId) {
          return formatToolResult({ error: 'goalId is required for abandon action' });
        }
        updateGoalStatus(db, goalId, 'abandoned');
        return formatToolResult({ message: `Goal #${goalId} abandoned` });
      }

      default:
        return formatToolResult({ error: `Unknown action: ${action}` });
    }
  },
});
