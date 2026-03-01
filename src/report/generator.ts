import type { Database } from '../db/compat-sqlite.js';
import {
  getProfitLoss,
  getSpendingSummary,
  getBudgetVsActual,
  getTransactions,
  getMonthlySavingsData,
} from '../db/queries.js';
import { checkAlerts } from '../alerts/engine.js';
import type { ReportSection } from './templates.js';
import { DEFAULT_SECTIONS } from './templates.js';

function sectionSummary(db: Database, startDate: string, endDate: string, label: string): string {
  const pnl = getProfitLoss(db, startDate, endDate);
  const txnCount = (db.prepare(
    'SELECT COUNT(*) AS c FROM transactions WHERE date >= @startDate AND date <= @endDate'
  ).get({ startDate, endDate }) as { c: number }).c;

  const lines = [`## Summary — ${label}`, ''];
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Transactions | ${txnCount} |`);
  lines.push(`| Total Income | $${pnl.totalIncome.toFixed(2)} |`);
  lines.push(`| Total Expenses | -$${Math.abs(pnl.totalExpenses).toFixed(2)} |`);
  lines.push(`| Net ${pnl.netProfitLoss >= 0 ? 'Profit' : 'Loss'} | ${pnl.netProfitLoss >= 0 ? '' : '-'}$${Math.abs(pnl.netProfitLoss).toFixed(2)} |`);
  return lines.join('\n');
}

function sectionSpending(db: Database, startDate: string, endDate: string): string {
  const rows = getSpendingSummary(db, startDate, endDate);
  if (rows.length === 0) return '## Spending by Category\n\nNo spending data.';

  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);
  const lines = ['## Spending by Category', ''];
  lines.push('| Category | Amount | % of Total | Count |');
  lines.push('|----------|--------|-----------|-------|');

  for (const row of rows) {
    const pct = grandTotal !== 0 ? ((row.total / grandTotal) * 100).toFixed(0) : '0';
    lines.push(`| ${row.category} | -$${Math.abs(row.total).toFixed(2)} | ${pct}% | ${row.count} |`);
  }
  lines.push(`| **Total** | **-$${Math.abs(grandTotal).toFixed(2)}** | **100%** | |`);
  return lines.join('\n');
}

function sectionBudget(db: Database, month: string): string {
  const rows = getBudgetVsActual(db, month);
  if (rows.length === 0) return '## Budget vs Actual\n\nNo budgets configured.';

  const lines = ['## Budget vs Actual', ''];
  lines.push('| Category | Budget | Actual | Remaining | Used |');
  lines.push('|----------|--------|--------|-----------|------|');

  for (const r of rows) {
    const status = r.over ? `**${r.percent_used}% OVER**` : `${r.percent_used}%`;
    const rem = r.over ? `-$${Math.abs(r.remaining).toFixed(2)}` : `$${r.remaining.toFixed(2)}`;
    lines.push(`| ${r.category} | $${r.monthly_limit.toFixed(2)} | $${r.actual.toFixed(2)} | ${rem} | ${status} |`);
  }
  return lines.join('\n');
}

function sectionAnomalies(db: Database): string {
  const alerts = checkAlerts(db);
  if (alerts.length === 0) return '## Alerts & Anomalies\n\nNo active alerts detected.';

  const lines = ['## Alerts & Anomalies', ''];
  for (const a of alerts) {
    const icon = a.severity === 'critical' ? '!!!' : a.severity === 'warning' ? '!!' : 'i';
    lines.push(`- [${icon}] ${a.message}`);
  }
  return lines.join('\n');
}

function sectionSavings(db: Database, month: string): string {
  const data = getMonthlySavingsData(db, month, 6);
  if (data.length === 0) return '## Savings Rate\n\nNo data available.';

  const lines = ['## Savings Rate Trend', ''];
  lines.push('| Month | Income | Expenses | Saved | Rate |');
  lines.push('|-------|--------|----------|-------|------|');

  for (const m of data) {
    lines.push(`| ${m.month} | $${m.income.toFixed(2)} | $${m.expenses.toFixed(2)} | $${m.savings.toFixed(2)} | ${m.savingsRate.toFixed(0)}% |`);
  }
  return lines.join('\n');
}

function sectionTransactions(db: Database, startDate: string, endDate: string): string {
  const txns = getTransactions(db, { dateStart: startDate, dateEnd: endDate });
  if (txns.length === 0) return '## Recent Transactions\n\nNo transactions in this period.';

  // Show up to 50
  const shown = txns.slice(0, 50);
  const lines = ['## Recent Transactions', ''];
  lines.push('| Date | Description | Amount | Category |');
  lines.push('|------|-------------|--------|----------|');

  for (const t of shown) {
    const amt = t.amount >= 0 ? `$${t.amount.toFixed(2)}` : `-$${Math.abs(t.amount).toFixed(2)}`;
    lines.push(`| ${t.date} | ${t.description} | ${amt} | ${t.category ?? 'Uncategorized'} |`);
  }

  if (txns.length > 50) {
    lines.push('', `*Showing 50 of ${txns.length} transactions.*`);
  }
  return lines.join('\n');
}

/**
 * Generate a full Markdown report.
 */
export function generateReport(
  db: Database,
  month?: string,
  sections?: ReportSection[]
): string {
  const targetMonth = month ?? new Date().toISOString().slice(0, 7);
  const [year, mon] = targetMonth.split('-').map(Number);
  const startDate = `${targetMonth}-01`;
  const endDate = new Date(year, mon, 0).toISOString().slice(0, 10);
  const label = new Date(year, mon - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });

  const activeSections = (!sections || sections.includes('all'))
    ? [...DEFAULT_SECTIONS]
    : sections.filter((s): s is Exclude<ReportSection, 'all'> => s !== 'all');

  const parts: string[] = [`# Financial Report — ${label}`, ''];
  parts.push(`*Generated: ${new Date().toISOString().slice(0, 10)}*`, '');

  for (const section of activeSections) {
    switch (section) {
      case 'summary': parts.push(sectionSummary(db, startDate, endDate, label)); break;
      case 'spending': parts.push(sectionSpending(db, startDate, endDate)); break;
      case 'budget': parts.push(sectionBudget(db, targetMonth)); break;
      case 'anomalies': parts.push(sectionAnomalies(db)); break;
      case 'savings': parts.push(sectionSavings(db, targetMonth)); break;
      case 'transactions': parts.push(sectionTransactions(db, startDate, endDate)); break;
    }
    parts.push('');
  }

  return parts.join('\n');
}
