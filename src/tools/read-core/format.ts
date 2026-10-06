// ── read-core: result formatters ─────────────────────────────────────────────
//
// Pure copies of the display formatters in the server read tools
// (transaction-search.ts formatResults, spending-summary.ts formatSummary,
// profit-loss.ts formatPnl). The `formatted` string is part of each tool's
// `.data`, so it must match byte for byte; mirror-tool-parity.test.ts pins it.
//
// Zero-import apart from shared row types.

import type { ProfitLossRow, SpendingSummaryRow } from '../../db/overview-sql.js';

/** The columns formatSearchResults reads from a transaction row. */
export interface SearchResultRow {
  date: string;
  amount: number;
  category: string | null;
  description: string;
}

/** Format transaction rows for display. */
export function formatSearchResults(transactions: SearchResultRow[]): string {
  if (transactions.length === 0) {
    return 'No transactions found matching your query.';
  }

  const lines = transactions.slice(0, 100).map((t) => {
    const cat = t.category ?? 'Uncategorized';
    const amt = t.amount < 0 ? `-$${Math.abs(t.amount).toFixed(2)}` : `+$${t.amount.toFixed(2)}`;
    return `${t.date}  ${amt.padStart(10)}  ${cat.padEnd(16)}  ${t.description}`;
  });

  const total = transactions.reduce((sum, t) => sum + t.amount, 0);
  const totalFormatted = total < 0 ? `-$${Math.abs(total).toFixed(2)}` : `+$${total.toFixed(2)}`;

  return [
    `Found ${transactions.length} transaction${transactions.length === 1 ? '' : 's'}:`,
    '',
    'Date        Amount      Category          Description',
    '----------  ----------  ----------------  -----------',
    ...lines,
    '',
    `Total: ${totalFormatted}`,
    transactions.length > 100 ? `\n(Showing first 100 of ${transactions.length})` : '',
  ].join('\n');
}

/** Format a spending summary for display. */
export function formatSpendingSummary(
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

/** Format a profit & loss report for display. */
export function formatPnl(pnl: ProfitLossRow, label: string): string {
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
