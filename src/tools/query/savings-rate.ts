import { z } from 'zod';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { getMonthlySavingsData, type MonthlyIncomeExpense } from '../../db/queries.js';
import { formatToolResult } from '../types.js';

let db: Database | null = null;

export function initSavingsRateTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) throw new Error('savings_rate tool not initialized. Call initSavingsRateTool(database) first.');
  return db;
}

function formatSavings(data: MonthlyIncomeExpense[]): string {
  if (data.length === 0) return 'No income/expense data found for the requested period.';

  const lines: string[] = ['Savings Rate Trend', ''];
  lines.push('Month'.padEnd(10) + 'Income'.padStart(12) + 'Expenses'.padStart(12) + 'Saved'.padStart(12) + 'Rate'.padStart(8));
  lines.push('-'.repeat(54));

  for (const m of data) {
    lines.push(
      m.month.padEnd(10) +
      `$${m.income.toFixed(2)}`.padStart(12) +
      `$${m.expenses.toFixed(2)}`.padStart(12) +
      `${m.savings >= 0 ? '$' : '-$'}${Math.abs(m.savings).toFixed(2)}`.padStart(12) +
      `${m.savingsRate.toFixed(0)}%`.padStart(8)
    );
  }

  // Latest month 50/30/20 benchmark
  const latest = data[data.length - 1];
  if (latest && latest.income > 0) {
    lines.push('');
    lines.push(`50/30/20 Benchmark (${latest.month}):`);
    const needs = latest.income * 0.5;
    const wants = latest.income * 0.3;
    const savings = latest.income * 0.2;
    lines.push(`  Needs (50%):   $${needs.toFixed(2)}`);
    lines.push(`  Wants (30%):   $${wants.toFixed(2)}`);
    lines.push(`  Savings (20%): $${savings.toFixed(2)}`);
    lines.push(`  Your savings:  $${latest.savings.toFixed(2)} (${latest.savingsRate.toFixed(0)}%)`);
  }

  return lines.join('\n');
}

export const savingsRateTool = defineTool({
  name: 'savings_rate',
  description:
    'Calculate savings rate trend showing income, expenses, and savings for each month. Includes 50/30/20 benchmark.',
  schema: z.object({
    months: z.number().default(6).describe('Number of months to include'),
    endMonth: z.string().optional().describe('End month (YYYY-MM, default: current)'),
  }),
  func: async ({ months, endMonth }) => {
    const database = getDb();
    const data = getMonthlySavingsData(database, endMonth, months);
    const formatted = formatSavings(data);

    return formatToolResult({
      months: data,
      formatted,
    });
  },
});
