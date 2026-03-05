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
} from '../../db/goal-queries.js';

let db: Database;

export function initGoalManageTool(database: Database) {
  db = database;
}

export const goalManageTool = defineTool({
  name: 'goal_manage',
  description: 'Manage financial and behavioral goals — add, update, track progress, list, or change status.',
  schema: z.object({
    action: z.enum(['add', 'update', 'progress', 'list', 'complete', 'pause', 'abandon']).describe('Action to perform'),
    title: z.string().optional().describe('Goal title (required for add)'),
    goalType: z.enum(['financial', 'behavioral']).optional().describe('Goal type (required for add)'),
    targetAmount: z.number().optional().describe('Target amount in dollars (financial goals)'),
    targetDate: z.string().optional().describe('Target date (ISO format, e.g. 2026-12-31)'),
    category: z.string().optional().describe('Spending category this goal relates to'),
    accountId: z.number().optional().describe('Account ID this goal tracks'),
    goalId: z.number().optional().describe('Goal ID (required for update/progress/complete/pause/abandon)'),
    currentAmount: z.number().optional().describe('Current progress amount (for progress action)'),
    notes: z.string().optional().describe('Optional notes'),
  }),
  func: async ({ action, title, goalType, targetAmount, targetDate, category, accountId, goalId, currentAmount, notes }) => {
    switch (action) {
      case 'add': {
        if (!title || !goalType) {
          return formatToolResult({ error: 'title and goalType are required for add action' });
        }
        const id = upsertGoal(db, { title, goalType, targetAmount, targetDate, category, accountId, notes });
        const goal = getGoalById(db, id);
        return formatToolResult({ message: `Goal created: "${title}"`, goal });
      }

      case 'update': {
        if (!goalId) {
          return formatToolResult({ error: 'goalId is required for update action' });
        }
        upsertGoal(db, { id: goalId, title: title ?? '', goalType: goalType ?? 'financial', targetAmount, targetDate, category, accountId, notes });
        const goal = getGoalById(db, goalId);
        return formatToolResult({ message: `Goal #${goalId} updated`, goal });
      }

      case 'progress': {
        if (!goalId || currentAmount === undefined) {
          return formatToolResult({ error: 'goalId and currentAmount are required for progress action' });
        }
        updateGoalProgress(db, goalId, currentAmount);
        const goal = getGoalById(db, goalId);
        if (goal && goal.target_amount && currentAmount >= goal.target_amount) {
          return formatToolResult({ message: `Goal #${goalId} progress updated to $${currentAmount}. Target reached!`, goal });
        }
        return formatToolResult({ message: `Goal #${goalId} progress updated to $${currentAmount}`, goal });
      }

      case 'list': {
        const goals = getAllGoals(db);
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
