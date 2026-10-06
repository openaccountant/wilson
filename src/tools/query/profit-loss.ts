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

export interface ProfitLossOptions {
  period?: 'month' | 'quarter' | 'year';
  offset?: number;
}

/**
 * Profit & loss for a period, read from the database passed in (see
 * computeSpendingSummary for why the chat and WebMCP tools share this).
 */
export function computeProfitLoss(database: Database, opts: ProfitLossOptions = {}) {
  const { start, end, label } = getPeriodDates(opts.period ?? 'month', opts.offset ?? 0);
  const pnl = getProfitLoss(database, start, end);
  const formatted = formatPnl(pnl, label);

  return {
    period: label,
    dateRange: { start, end },
    ...pnl,
    formatted,
  };
}

export const profitLossTool = defineTool({
  name: 'profit_loss',
  mutates: false, // audited read-only (#152, src/__tests__/mutation-audit.ts)
  description:
    'Generate a profit & loss report showing income vs expenses by category for a given period.',
  schema: z.object({
    period: z.enum(['month', 'quarter', 'year']).default('month')
      .describe('Time period for the P&L report'),
    offset: z.number().default(0)
      .describe('Period offset (0=current, -1=previous)'),
  }),
  func: async ({ period, offset }) => {
    return formatToolResult(computeProfitLoss(getDb(), { period, offset }));
  },
});
