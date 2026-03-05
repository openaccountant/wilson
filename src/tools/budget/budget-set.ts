import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import type { Database } from '../../db/compat-sqlite.js';
import { setBudget, resolveCategory } from '../../db/queries.js';

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
    // Resolve to canonical category name if it exists in the categories table
    let canonicalName = category;
    let warning: string | undefined;
    try {
      const resolved = resolveCategory(db, category);
      if (resolved) {
        canonicalName = resolved;
      } else {
        warning = `Note: "${category}" is not in the categories table. Budget will still be created.`;
      }
    } catch {
      // Categories table may not exist yet — use as-is
    }

    setBudget(db, canonicalName, monthlyLimit);
    return formatToolResult({
      category: canonicalName,
      monthlyLimit,
      warning,
      message: `Budget set: ${canonicalName} → $${monthlyLimit}/month`,
    });
  },
});
