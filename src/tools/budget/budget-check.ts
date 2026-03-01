import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import type { Database } from '../../db/compat-sqlite.js';
import { getBudgetVsActual } from '../../db/queries.js';

let db: Database;

export function initBudgetCheckTool(database: Database) {
  db = database;
}

export const budgetCheckTool = defineTool({
  name: 'budget_check',
  description: 'Compare actual spending vs budget limits for the current or specified month.',
  schema: z.object({
    month: z.string().optional().describe('Month to check (YYYY-MM), defaults to current month'),
    category: z.string().optional().describe('Specific category, or all if omitted'),
  }),
  func: async ({ month, category }) => {
    const targetMonth = month ?? new Date().toISOString().slice(0, 7);
    let results = getBudgetVsActual(db, targetMonth);

    if (category) {
      results = results.filter((r) => r.category.toLowerCase() === category.toLowerCase());
    }

    if (results.length === 0) {
      return formatToolResult({
        month: targetMonth,
        message: category
          ? `No budget set for "${category}". Use budget_set to create one.`
          : 'No budgets set. Use budget_set to create budgets.',
      });
    }

    return formatToolResult({
      month: targetMonth,
      budgets: results.map((r) => ({
        category: r.category,
        budget: r.monthly_limit,
        actual: r.actual,
        remaining: r.remaining,
        percentUsed: r.percent_used,
        status: r.over ? 'OVER' : 'OK',
      })),
    });
  },
});
