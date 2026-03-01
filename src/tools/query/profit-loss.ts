import { z } from 'zod';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { getProfitLoss, type ProfitLossRow } from '../../db/queries.js';
import { getPeriodDates } from './spending-summary.js';
import { formatToolResult } from '../types.js';

let db: Database | null = null;

export function initProfitLossTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) throw new Error('profit_loss tool not initialized. Call initProfitLossTool(database) first.');
  return db;
}

function formatPnl(pnl: ProfitLossRow, label: string): string {
  const lines: string[] = [`Profit & Loss: ${label}`, ''];

  if (pnl.incomeByCategory.length > 0) {
    lines.push('INCOME');
    for (const r of pnl.incomeByCategory) {
      lines.push(`  ${r.category.padEnd(20)} $${r.total.toFixed(2).padStart(10)}  (${r.count} txns)`);
    }
    lines.push(`  ${'TOTAL INCOME'.padEnd(20)} $${pnl.totalIncome.toFixed(2).padStart(10)}`);
    lines.push('');
  }

  if (pnl.expensesByCategory.length > 0) {
    lines.push('EXPENSES');
    for (const r of pnl.expensesByCategory) {
      lines.push(`  ${r.category.padEnd(20)} -$${Math.abs(r.total).toFixed(2).padStart(9)}  (${r.count} txns)`);
    }
    lines.push(`  ${'TOTAL EXPENSES'.padEnd(20)} -$${Math.abs(pnl.totalExpenses).toFixed(2).padStart(9)}`);
    lines.push('');
  }

  lines.push('-'.repeat(40));
  const net = pnl.netProfitLoss;
  const sign = net >= 0 ? '+' : '-';
  lines.push(`NET ${net >= 0 ? 'PROFIT' : 'LOSS'}:`.padEnd(22) + `${sign}$${Math.abs(net).toFixed(2)}`);

  return lines.join('\n');
}

export const profitLossTool = defineTool({
  name: 'profit_loss',
  description:
    'Generate a profit & loss report showing income vs expenses by category for a given period.',
  schema: z.object({
    period: z.enum(['month', 'quarter', 'year']).default('month')
      .describe('Time period for the P&L report'),
    offset: z.number().default(0)
      .describe('Period offset (0=current, -1=previous)'),
  }),
  func: async ({ period, offset }) => {
    const database = getDb();
    const { start, end, label } = getPeriodDates(period, offset);
    const pnl = getProfitLoss(database, start, end);
    const formatted = formatPnl(pnl, label);

    return formatToolResult({
      period: label,
      dateRange: { start, end },
      ...pnl,
      formatted,
    });
  },
});
