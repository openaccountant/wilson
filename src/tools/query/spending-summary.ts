import { z } from 'zod';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { getSpendingSummary, type SpendingSummaryRow } from '../../db/queries.js';
import { formatToolResult } from '../types.js';

// Module-level database reference
let db: Database | null = null;

/**
 * Initialize the spending_summary tool with a database connection.
 * Must be called before the agent starts.
 */
export function initSpendingSummaryTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) {
    throw new Error(
      'spending_summary tool not initialized. Call initSpendingSummaryTool(database) first.'
    );
  }
  return db;
}

/**
 * Compute the start and end dates for a period.
 */
function getPeriodDates(
  period: 'month' | 'quarter' | 'year',
  offset: number = 0
): { start: string; end: string; label: string } {
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
 * Format a spending summary for display.
 */
function formatSummary(
  rows: SpendingSummaryRow[],
  label: string,
  prevRows?: SpendingSummaryRow[],
  prevLabel?: string
): string {
  const lines: string[] = [`Spending Summary: ${label}`, ''];

  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);

  // Build a map of previous period totals for comparison
  const prevMap = new Map<string, number>();
  let prevGrandTotal = 0;
  if (prevRows) {
    for (const r of prevRows) {
      prevMap.set(r.category, r.total);
      prevGrandTotal += r.total;
    }
  }

  lines.push(
    'Category'.padEnd(20) +
      'Amount'.padStart(12) +
      'Count'.padStart(8) +
      (prevRows ? '  Change'.padStart(10) : '')
  );
  lines.push('-'.repeat(prevRows ? 50 : 40));

  for (const row of rows) {
    const amt = `-$${Math.abs(row.total).toFixed(2)}`;
    let changePart = '';

    if (prevRows) {
      const prevAmt = prevMap.get(row.category);
      if (prevAmt !== undefined && prevAmt !== 0) {
        const pctChange = ((row.total - prevAmt) / Math.abs(prevAmt)) * 100;
        const sign = pctChange > 0 ? '+' : '';
        // For expenses (negative), "increase" means more negative
        // More negative = more spending, so flip the sign for display
        changePart = `  ${sign}${pctChange.toFixed(0)}%`;
      } else {
        changePart = '  new';
      }
    }

    lines.push(
      row.category.padEnd(20) +
        amt.padStart(12) +
        String(row.count).padStart(8) +
        changePart
    );
  }

  lines.push('-'.repeat(prevRows ? 50 : 40));
  const totalFmt = `-$${Math.abs(grandTotal).toFixed(2)}`;
  let totalChange = '';
  if (prevRows && prevGrandTotal !== 0) {
    const pctChange = ((grandTotal - prevGrandTotal) / Math.abs(prevGrandTotal)) * 100;
    const sign = pctChange > 0 ? '+' : '';
    totalChange = `  ${sign}${pctChange.toFixed(0)}%`;
  }
  lines.push('TOTAL'.padEnd(20) + totalFmt.padStart(12) + ''.padStart(8) + totalChange);

  if (prevLabel) {
    lines.push('', `Compared with: ${prevLabel}`);
  }

  return lines.join('\n');
}

/**
 * Spending summary tool — breaks down spending by category for a given period,
 * optionally comparing with the previous period.
 */
export const spendingSummaryTool = defineTool({
  name: 'spending_summary',
  description:
    'Get a spending breakdown by category for the current month, quarter, or year. ' +
    'Optionally compare with the previous period to see changes.',
  schema: z.object({
    period: z
      .enum(['month', 'quarter', 'year'])
      .default('month')
      .describe('Time period for the summary'),
    compareWithPrevious: z
      .boolean()
      .default(true)
      .describe('Compare with the previous period'),
  }),
  func: async ({ period, compareWithPrevious }) => {
    const database = getDb();

    // Current period
    const current = getPeriodDates(period, 0);
    const currentRows = getSpendingSummary(database, current.start, current.end);

    // Previous period (if requested)
    let prevRows: SpendingSummaryRow[] | undefined;
    let prevLabel: string | undefined;
    if (compareWithPrevious) {
      const prev = getPeriodDates(period, -1);
      prevRows = getSpendingSummary(database, prev.start, prev.end);
      prevLabel = prev.label;
    }

    const formatted = formatSummary(currentRows, current.label, prevRows, prevLabel);

    const grandTotal = currentRows.reduce((sum, r) => sum + r.total, 0);
    const transactionCount = currentRows.reduce((sum, r) => sum + r.count, 0);

    return formatToolResult({
      period: current.label,
      dateRange: { start: current.start, end: current.end },
      totalSpending: grandTotal,
      transactionCount,
      categories: currentRows,
      previousPeriod: prevRows
        ? {
            label: prevLabel,
            categories: prevRows,
            totalSpending: prevRows.reduce((sum, r) => sum + r.total, 0),
          }
        : undefined,
      formatted,
    });
  },
});
