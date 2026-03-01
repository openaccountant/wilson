import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import type { Database } from '../../db/compat-sqlite.js';
import { setBudget } from '../../db/queries.js';

let db: Database;

export function initBudgetSetTool(database: Database) {
  db = database;
}

export const budgetSetTool = defineTool({
  name: 'budget_set',
  description: 'Set or update a monthly spending budget for a category.',
  schema: z.object({
    category: z.string().describe('Spending category (e.g., Dining, Groceries, Shopping)'),
    monthlyLimit: z.number().describe('Monthly spending limit in dollars'),
  }),
  func: async ({ category, monthlyLimit }) => {
    setBudget(db, category, monthlyLimit);
    return formatToolResult({
      category,
      monthlyLimit,
      message: `Budget set: ${category} → $${monthlyLimit}/month`,
    });
  },
});
