import * as XLSX from 'xlsx';
import { writeFileSync } from 'fs';
import { initDatabase } from './db/database.js';
import type { Database } from './db/compat-sqlite.js';
import {
  getTransactions,
  getSpendingSummary,
  getBudgetVsActual,
  getUncategorizedTransactions,
  getBudgets,
  getProfitLoss,
  getMonthlySavingsData,
  getTaxSummary,
  type TransactionFilters,
} from './db/queries.js';
import { getPeriodDates } from './tools/query/spending-summary.js';
import { checkAlerts } from './alerts/engine.js';
import { generateReport } from './report/generator.js';
import { getNetWorthSummary, getEquitySummary } from './db/net-worth-queries.js';
import { SUBTYPE_LABELS, type AccountSubtype } from './tools/net-worth/account-types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

export function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const val = args[idx + 1];
  if (val.startsWith('--')) return undefined;
  return val;
}

// ── --status ─────────────────────────────────────────────────────────────────

export async function printStatus(injectedDb?: Database): Promise<void> {
  const db = injectedDb ?? initDatabase();

  try {
    const totalCount = (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c;

    const dateRange = db.prepare(
      'SELECT MIN(date) AS min_date, MAX(date) AS max_date FROM transactions'
    ).get() as { min_date: string | null; max_date: string | null };

    const sources = db.prepare(
      `SELECT COALESCE(bank, 'Unknown') AS source, COUNT(*) AS c FROM transactions GROUP BY bank ORDER BY c DESC`
    ).all() as { source: string; c: number }[];

    const uncategorizedCount = getUncategorizedTransactions(db).length;
    const categorizedCount = totalCount - uncategorizedCount;

    const budgetCount = getBudgets(db).length;

    const importCount = (db.prepare('SELECT COUNT(*) AS c FROM imports').get() as { c: number }).c;

    console.log('Open Accountant Database Status');
    console.log('='.repeat(40));
    console.log(`Transactions:    ${totalCount}`);
    if (dateRange.min_date) {
      console.log(`Date range:      ${dateRange.min_date} to ${dateRange.max_date}`);
    }
    console.log(`Categorized:     ${categorizedCount}`);
    console.log(`Uncategorized:   ${uncategorizedCount}`);
    if (sources.length > 0) {
      console.log(`Sources:         ${sources.map((s) => `${s.source} (${s.c})`).join(', ')}`);
    }
    console.log(`Budgets:         ${budgetCount}`);
    console.log(`Imports:         ${importCount}`);

    // Show active alerts
    try {
      const alerts = checkAlerts(db);
      if (alerts.length > 0) {
        console.log('');
        console.log(`Active Alerts (${alerts.length}):`);
        for (const a of alerts) {
          const icon = a.severity === 'critical' ? '!!!' : a.severity === 'warning' ? '!!' : 'i';
          console.log(`  [${icon}] ${a.message}`);
        }
      }
    } catch {
      // Alert check is best-effort
    }
  } finally {
    if (!injectedDb) db.close();
  }
}

// ── --summary ────────────────────────────────────────────────────────────────

export async function printSummary(args: string[], injectedDb?: Database): Promise<void> {
  const db = injectedDb ?? initDatabase();

  try {
    // Parse period: next arg after --summary if it's month/quarter/year
    const summaryIdx = args.indexOf('--summary');
    const nextArg = args[summaryIdx + 1];
    const period = (['month', 'quarter', 'year'].includes(nextArg) ? nextArg : 'month') as
      | 'month'
      | 'quarter'
      | 'year';

    const offsetStr = getArgValue(args, '--offset');
    const offset = offsetStr ? parseInt(offsetStr, 10) : 0;

    const { start, end, label } = getPeriodDates(period, offset);
    const rows = getSpendingSummary(db, start, end);

    if (rows.length === 0) {
      console.log(`No spending data for ${label} (${start} to ${end}).`);
      return;
    }

    const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);

    console.log(`Spending Summary: ${label}`);
    console.log(`(${start} to ${end})`);
    console.log('');
    console.log('Category'.padEnd(22) + 'Amount'.padStart(12) + '  %'.padStart(6) + 'Count'.padStart(8));
    console.log('-'.repeat(48));

    for (const row of rows) {
      const amt = `-$${Math.abs(row.total).toFixed(2)}`;
      const pct = grandTotal !== 0 ? ((row.total / grandTotal) * 100).toFixed(0) : '0';
      console.log(
        row.category.padEnd(22) + amt.padStart(12) + `${pct}%`.padStart(6) + String(row.count).padStart(8)
      );
    }

    console.log('-'.repeat(48));
    console.log('TOTAL'.padEnd(22) + `-$${Math.abs(grandTotal).toFixed(2)}`.padStart(12));
  } finally {
    if (!injectedDb) db.close();
  }
}

// ── --budget ─────────────────────────────────────────────────────────────────

export async function printBudget(args: string[], injectedDb?: Database): Promise<void> {
  const db = injectedDb ?? initDatabase();

  try {
    const monthArg = getArgValue(args, '--month');
    const month = monthArg ?? new Date().toISOString().slice(0, 7); // YYYY-MM

    const rows = getBudgetVsActual(db, month);

    if (rows.length === 0) {
      console.log(`No budgets configured. Use the interactive mode to set budgets.`);
      return;
    }

    console.log(`Budget vs Actual: ${month}`);
    console.log('');
    console.log(
      'Category'.padEnd(18) +
        'Budget'.padStart(10) +
        'Actual'.padStart(10) +
        'Remaining'.padStart(12) +
        '  Used'.padStart(8)
    );
    console.log('-'.repeat(58));

    for (const row of rows) {
      const budget = `$${row.monthly_limit.toFixed(2)}`;
      const actual = `$${row.actual.toFixed(2)}`;
      const remaining = row.remaining >= 0 ? `$${row.remaining.toFixed(2)}` : `-$${Math.abs(row.remaining).toFixed(2)}`;
      const pct = `${row.percent_used}%`;
      const marker = row.over ? ' OVER' : '';

      console.log(
        row.category.padEnd(18) +
          budget.padStart(10) +
          actual.padStart(10) +
          remaining.padStart(12) +
          pct.padStart(8) +
          marker
      );
    }
  } finally {
    if (!injectedDb) db.close();
  }
}

// ── --pnl ───────────────────────────────────────────────────────────────────

export async function printPnl(args: string[], injectedDb?: Database): Promise<void> {
  const db = injectedDb ?? initDatabase();

  try {
    const periodIdx = args.indexOf('--pnl');
    const nextArg = args[periodIdx + 1];
    const period = (['month', 'quarter', 'year'].includes(nextArg) ? nextArg : 'month') as
      | 'month'
      | 'quarter'
      | 'year';

    const offsetStr = getArgValue(args, '--offset');
    const offset = offsetStr ? parseInt(offsetStr, 10) : 0;

    const { start, end, label } = getPeriodDates(period, offset);
    const pnl = getProfitLoss(db, start, end);

    console.log(`Profit & Loss: ${label}`);
    console.log(`(${start} to ${end})`);
    console.log('');

    if (pnl.incomeByCategory.length > 0) {
      console.log('INCOME');
      for (const r of pnl.incomeByCategory) {
        console.log(`  ${r.category.padEnd(20)} $${r.total.toFixed(2).padStart(10)}  (${r.count} txns)`);
      }
      console.log(`  ${'TOTAL'.padEnd(20)} $${pnl.totalIncome.toFixed(2).padStart(10)}`);
      console.log('');
    }

    if (pnl.expensesByCategory.length > 0) {
      console.log('EXPENSES');
      for (const r of pnl.expensesByCategory) {
        console.log(`  ${r.category.padEnd(20)} -$${Math.abs(r.total).toFixed(2).padStart(9)}  (${r.count} txns)`);
      }
      console.log(`  ${'TOTAL'.padEnd(20)} -$${Math.abs(pnl.totalExpenses).toFixed(2).padStart(9)}`);
      console.log('');
    }

    console.log('-'.repeat(40));
    const net = pnl.netProfitLoss;
    const sign = net >= 0 ? '+' : '-';
    console.log(`NET ${net >= 0 ? 'PROFIT' : 'LOSS'}:`.padEnd(22) + `${sign}$${Math.abs(net).toFixed(2)}`);
  } finally {
    if (!injectedDb) db.close();
  }
}

// ── --savings ────────────────────────────────────────────────────────────────

export async function printSavings(args: string[], injectedDb?: Database): Promise<void> {
  const db = injectedDb ?? initDatabase();

  try {
    const monthsStr = getArgValue(args, '--months');
    const months = monthsStr ? parseInt(monthsStr, 10) : 6;

    const data = getMonthlySavingsData(db, undefined, months);

    if (data.length === 0) {
      console.log('No income/expense data found.');
      return;
    }

    console.log('Savings Rate Trend');
    console.log('');
    console.log('Month'.padEnd(10) + 'Income'.padStart(12) + 'Expenses'.padStart(12) + 'Saved'.padStart(12) + 'Rate'.padStart(8));
    console.log('-'.repeat(54));

    for (const m of data) {
      console.log(
        m.month.padEnd(10) +
        `$${m.income.toFixed(2)}`.padStart(12) +
        `$${m.expenses.toFixed(2)}`.padStart(12) +
        `${m.savings >= 0 ? '$' : '-$'}${Math.abs(m.savings).toFixed(2)}`.padStart(12) +
        `${m.savingsRate.toFixed(0)}%`.padStart(8)
      );
    }

    const latest = data[data.length - 1];
    if (latest && latest.income > 0) {
      console.log('');
      console.log(`50/30/20 Benchmark (${latest.month}):`);
      console.log(`  Needs (50%):   $${(latest.income * 0.5).toFixed(2)}`);
      console.log(`  Wants (30%):   $${(latest.income * 0.3).toFixed(2)}`);
      console.log(`  Savings (20%): $${(latest.income * 0.2).toFixed(2)}`);
      console.log(`  Your savings:  $${latest.savings.toFixed(2)} (${latest.savingsRate.toFixed(0)}%)`);
    }
  } finally {
    if (!injectedDb) db.close();
  }
}

// ── --tax-summary ────────────────────────────────────────────────────────────

export async function printTaxSummary(args: string[], injectedDb?: Database): Promise<void> {
  const db = injectedDb ?? initDatabase();

  try {
    const yearStr = getArgValue(args, '--tax-summary');
    const year = yearStr ? parseInt(yearStr, 10) : new Date().getFullYear();

    const summary = getTaxSummary(db, year);

    if (summary.length === 0) {
      console.log(`No tax deductions flagged for ${year}.`);
      return;
    }

    console.log(`Tax Deductions Summary — ${year}`);
    console.log('');
    console.log('IRS Category'.padEnd(36) + 'Amount'.padStart(12) + 'Items'.padStart(8));
    console.log('-'.repeat(56));

    let grandTotal = 0;
    for (const r of summary) {
      grandTotal += r.total;
      console.log(
        r.irs_category.padEnd(36) +
        `$${r.total.toFixed(2)}`.padStart(12) +
        String(r.count).padStart(8)
      );
    }

    console.log('-'.repeat(56));
    console.log('TOTAL DEDUCTIONS'.padEnd(36) + `$${grandTotal.toFixed(2)}`.padStart(12));
  } finally {
    if (!injectedDb) db.close();
  }
}

// ── --report ─────────────────────────────────────────────────────────────────

export async function runReport(args: string[], injectedDb?: Database): Promise<void> {
  const db = injectedDb ?? initDatabase();

  try {
    const filePath = getArgValue(args, '--report');
    if (!filePath) {
      console.error('Error: --report requires a file path. Example: wilson --report ~/report.md');
      process.exit(1);
    }

    const resolvedPath = filePath.startsWith('~')
      ? filePath.replace('~', process.env.HOME ?? '')
      : filePath;

    const monthArg = getArgValue(args, '--month');
    const markdown = generateReport(db, monthArg);

    writeFileSync(resolvedPath, markdown);
    console.log(`Report saved to ${resolvedPath}`);
  } finally {
    if (!injectedDb) db.close();
  }
}

// ── --export ─────────────────────────────────────────────────────────────────

export async function runExport(args: string[], injectedDb?: Database): Promise<void> {
  const db = injectedDb ?? initDatabase();

  try {
    const filePath = getArgValue(args, '--export');
    if (!filePath) {
      console.error('Error: --export requires a file path. Example: wilson --export ~/transactions.csv');
      process.exit(1);
    }

    // Resolve ~ to home directory
    const resolvedPath = filePath.startsWith('~')
      ? filePath.replace('~', process.env.HOME ?? '')
      : filePath;

    const formatArg = getArgValue(args, '--format');
    const format = formatArg === 'xlsx' ? 'xlsx' : 'csv';

    // Build filters
    const filters: TransactionFilters = {};
    const startDate = getArgValue(args, '--start');
    const endDate = getArgValue(args, '--end');
    const category = getArgValue(args, '--category');
    if (startDate) filters.dateStart = startDate;
    if (endDate) filters.dateEnd = endDate;
    if (category) filters.category = category;

    const transactions = getTransactions(db, filters);

    if (transactions.length === 0) {
      console.log('No transactions found matching the specified filters.');
      return;
    }

    const rows = transactions.map((t) => ({
      date: t.date,
      description: t.description,
      amount: t.amount,
      category: t.category ?? '',
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Transactions');

    try {
      XLSX.writeFile(wb, resolvedPath, { bookType: format });
      console.log(`Exported ${transactions.length} transactions to ${resolvedPath} (${format.toUpperCase()}).`);
    } catch (err) {
      console.error(`Failed to write file: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  } finally {
    if (!injectedDb) db.close();
  }
}

// ── --net-worth ──────────────────────────────────────────────────────────────

export async function printNetWorth(_args: string[], injectedDb?: Database): Promise<void> {
  const db = injectedDb ?? initDatabase();

  try {
    const summary = getNetWorthSummary(db);

    if (summary.accounts.length === 0) {
      console.log('No accounts configured. Use interactive mode to add accounts.');
      return;
    }

    const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    console.log('Net Worth Summary');
    console.log('='.repeat(40));
    console.log('');

    if (summary.assetsBySubtype.length > 0) {
      console.log('ASSETS');
      for (const a of summary.assetsBySubtype) {
        const label = SUBTYPE_LABELS[a.subtype as AccountSubtype] ?? a.subtype;
        console.log(`  ${label.padEnd(20)} ${fmt(a.total).padStart(14)}  (${a.count})`);
      }
      console.log(`  ${'TOTAL'.padEnd(20)} ${fmt(summary.totalAssets).padStart(14)}`);
      console.log('');
    }

    if (summary.liabilitiesBySubtype.length > 0) {
      console.log('LIABILITIES');
      for (const l of summary.liabilitiesBySubtype) {
        const label = SUBTYPE_LABELS[l.subtype as AccountSubtype] ?? l.subtype;
        console.log(`  ${label.padEnd(20)} ${fmt(l.total).padStart(14)}  (${l.count})`);
      }
      console.log(`  ${'TOTAL'.padEnd(20)} ${fmt(summary.totalLiabilities).padStart(14)}`);
      console.log('');
    }

    console.log('-'.repeat(40));
    const nw = summary.netWorth;
    console.log(`NET WORTH:`.padEnd(22) + `${fmt(nw)}`);
  } finally {
    if (!injectedDb) db.close();
  }
}

// ── --balance-sheet ──────────────────────────────────────────────────────────

export async function printBalanceSheet(_args: string[], injectedDb?: Database): Promise<void> {
  const db = injectedDb ?? initDatabase();

  try {
    const summary = getNetWorthSummary(db);

    if (summary.accounts.length === 0) {
      console.log('No accounts configured. Use interactive mode to add accounts.');
      return;
    }

    const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    console.log('Balance Sheet');
    console.log('='.repeat(60));
    console.log('');

    const assets = summary.accounts.filter((a) => a.account_type === 'asset');
    const liabilities = summary.accounts.filter((a) => a.account_type === 'liability');

    if (assets.length > 0) {
      console.log('ASSETS');
      console.log('  ' + 'Account'.padEnd(24) + 'Type'.padEnd(16) + 'Balance'.padStart(14));
      console.log('  ' + '-'.repeat(54));
      for (const a of assets) {
        const label = SUBTYPE_LABELS[a.account_subtype as AccountSubtype] ?? a.account_subtype;
        console.log(`  ${a.name.padEnd(24)}${label.padEnd(16)}${fmt(a.current_balance).padStart(14)}`);
      }
      console.log(`  ${'TOTAL ASSETS'.padEnd(40)}${fmt(summary.totalAssets).padStart(14)}`);
      console.log('');
    }

    if (liabilities.length > 0) {
      console.log('LIABILITIES');
      console.log('  ' + 'Account'.padEnd(24) + 'Type'.padEnd(16) + 'Balance'.padStart(14));
      console.log('  ' + '-'.repeat(54));
      for (const a of liabilities) {
        const label = SUBTYPE_LABELS[a.account_subtype as AccountSubtype] ?? a.account_subtype;
        console.log(`  ${a.name.padEnd(24)}${label.padEnd(16)}${fmt(a.current_balance).padStart(14)}`);
      }
      console.log(`  ${'TOTAL LIABILITIES'.padEnd(40)}${fmt(summary.totalLiabilities).padStart(14)}`);
      console.log('');
    }

    // Equity summary for financed assets
    const equity = getEquitySummary(db);
    if (equity.length > 0) {
      console.log('EQUITY (Financed Assets)');
      console.log('  ' + 'Asset'.padEnd(20) + 'Value'.padStart(12) + 'Loan'.padStart(12) + 'Equity'.padStart(12) + '  %'.padStart(6));
      console.log('  ' + '-'.repeat(62));
      for (const e of equity) {
        console.log(
          `  ${e.assetName.padEnd(20)}${fmt(e.assetValue).padStart(12)}${fmt(e.loanBalance).padStart(12)}${fmt(e.equity).padStart(12)}${(e.equityPercent + '%').padStart(6)}`
        );
      }
      console.log('');
    }

    console.log('='.repeat(60));
    console.log(`NET WORTH:`.padEnd(42) + fmt(summary.netWorth));
  } finally {
    if (!injectedDb) db.close();
  }
}
