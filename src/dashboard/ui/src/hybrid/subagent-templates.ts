/**
 * Deterministic local answer writing (specs/DECISIONS.md "Round 3", "Local answer writing").
 *
 * One template per read tool turns the tool RESULT into the answer: labeled figures, the period stated
 * explicitly, top categories by amount (the footer / TOTAL row is never a category) and one consistent
 * currency format. No model is involved, so the answer cannot say a figure the data does not hold, name
 * a footer row as the biggest category, or leave the period out (the Round-2 defects).
 *
 * Pure and total: `renderTemplate` returns null (never throws) when the data is not shaped as the
 * tool returns it, and the caller hands off. Untrusted row text is cleaned here; the caller still runs
 * the grounding / markup check over the result before it ships.
 */

import type { ReadToolName } from '../store/mirror-tools.js';

export interface TemplateOptions {
  /** ISO date (YYYY-MM-DD) of the run. Never stated as a data date: a template dates an answer only from the result itself. */
  today: string;
}

const TOP_PNL = 3;
const TOP_SPENDING = 5;
const TOP_NET_WORTH = 5;
const MAX_LISTED_ROWS = 10;
const DESCRIPTION_CHARS = 50;
const LABEL_CHARS = 40;

/** `$3,021.71`, `-$1,234.56`. The sign goes in front of the dollar sign; a rounded-to-zero amount has none. */
export function formatUsd(n: number): string {
  const cents = Math.round(Math.abs(n) * 100);
  if (!Number.isFinite(cents) || cents === 0) return '$0.00';
  const dollars = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 ? '-' : ''}$${dollars}.${String(cents % 100).padStart(2, '0')}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** Untrusted text: control characters out, whitespace collapsed, length capped. */
function clean(text: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  const t = String(text ?? '').replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`;
}

const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

interface Ranked {
  name: string;
  amount: number;
}

/** A footer / grand-total row is never a category. */
const FOOTER_NAME = /^\s*(?:grand\s+)?totals?\b/i;

/** Category rows ranked by absolute amount, footer rows and zero rows dropped. */
function rank(rows: unknown, amountKey: string, nameKey: string, limit: number): Ranked[] {
  if (!Array.isArray(rows)) return [];
  const out: Ranked[] = [];
  for (const r of rows) {
    if (!isRecord(r)) continue;
    const name = str(r[nameKey]) ?? str(r.subtype);
    const amount = num(r[amountKey]) ?? num(r.balance);
    if (name === undefined || amount === undefined || amount === 0 || FOOTER_NAME.test(name)) continue;
    out.push({ name: clean(name, LABEL_CHARS), amount: Math.abs(amount) });
  }
  out.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  return out.slice(0, limit);
}

const list = (items: Ranked[]): string => items.map((c) => `${c.name} ${formatUsd(c.amount)}`).join(', ');

// ── per-tool templates ───────────────────────────────────────────────────────

function profitLoss(d: Record<string, unknown>): string | null {
  const period = str(d.period);
  const income = num(d.totalIncome);
  const expenses = num(d.totalExpenses);
  const net = num(d.netProfitLoss) ?? num(d.netProfit);
  if (period === undefined || income === undefined || expenses === undefined || net === undefined) return null;
  const lines = [`Net for ${clean(period, LABEL_CHARS)}: ${formatUsd(net)} (income ${formatUsd(income)}, expenses ${formatUsd(Math.abs(expenses))}).`];
  const topExpenses = rank(d.expensesByCategory, 'total', 'category', TOP_PNL);
  if (topExpenses.length > 0) lines.push(`Top expense categories: ${list(topExpenses)}.`);
  const topIncome = rank(d.incomeByCategory, 'total', 'category', TOP_PNL);
  if (topIncome.length > 0) lines.push(`Top income categories: ${list(topIncome)}.`);
  return lines.join('\n');
}

function spendingSummary(d: Record<string, unknown>): string | null {
  const period = str(d.period);
  const total = num(d.totalSpending);
  if (period === undefined || total === undefined) return null;
  const count = num(d.transactionCount);
  const lines = [`Spending for ${clean(period, LABEL_CHARS)}: ${formatUsd(Math.abs(total))}${count === undefined ? '' : ` across ${plural(count, 'transaction')}`}.`];
  const top = rank(d.categories, 'total', 'category', TOP_SPENDING);
  if (top.length > 0) lines.push(`Top categories: ${list(top)}.`);
  const prev = d.previousPeriod;
  if (isRecord(prev)) {
    const label = str(prev.label);
    const prevTotal = num(prev.totalSpending);
    if (label !== undefined && prevTotal !== undefined && prevTotal !== 0) {
      lines.push(`Previous period (${clean(label, LABEL_CHARS)}): ${formatUsd(Math.abs(prevTotal))}.`);
    }
  }
  return lines.join('\n');
}

function dateRange(filters: unknown): string {
  const f = isRecord(filters) ? filters : {};
  const start = str(f.dateStart);
  const end = str(f.dateEnd);
  if (start && end) return `${clean(start, 10)} to ${clean(end, 10)}`;
  if (start) return `from ${clean(start, 10)}`;
  if (end) return `through ${clean(end, 10)}`;
  return 'all dates';
}

function transactionSearch(d: Record<string, unknown>): string | null {
  if (!Array.isArray(d.transactions)) return null;
  const rows: Array<{ date: string; amount: number; description: string; category: string }> = [];
  for (const t of d.transactions) {
    if (!isRecord(t)) return null;
    const date = str(t.date);
    const amount = num(t.amount);
    if (date === undefined || amount === undefined) return null;
    rows.push({ date: clean(date, 10), amount, description: clean(t.description, DESCRIPTION_CHARS), category: clean(t.category, LABEL_CHARS) || 'Uncategorized' });
  }
  const count = num(d.count) ?? rows.length;
  const net = rows.reduce((sum, r) => sum + r.amount, 0);
  const netText = rows.length === count ? `net ${formatUsd(net)}` : `net of the ${rows.length} rows returned ${formatUsd(net)}`;
  const lines = [`Found ${plural(count, 'transaction')} (${dateRange(d.filtersApplied)}), ${netText}:`];
  for (const r of rows.slice(0, MAX_LISTED_ROWS)) lines.push(`- ${r.date}: ${formatUsd(r.amount)}, ${r.description} (${r.category})`);
  if (count > MAX_LISTED_ROWS) lines.push(`...and ${count - Math.min(rows.length, MAX_LISTED_ROWS)} more.`);
  return lines.join('\n');
}

function netWorth(d: Record<string, unknown>, opts: TemplateOptions): string | null {
  const nw = num(d.netWorth);
  if (nw === undefined) return null;
  const assets = num(d.totalAssets);
  const liabilities = num(d.totalLiabilities);
  const detail = assets !== undefined && liabilities !== undefined ? ` (assets ${formatUsd(assets)}, liabilities ${formatUsd(Math.abs(liabilities))})` : '';
  // Round 4: state only a date the DATA holds. The mirror's net worth is a bare current-balance
  // summary with no snapshot date, so "as of today" would be a claim the result cannot back.
  const asOf = [d.asOf, d.snapshotDate].map((v) => str(v)).find((v): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));
  const lines = [`Net worth${asOf ? ` as of ${asOf}` : ''}: ${formatUsd(nw)}${detail}.`];
  const a = rank(d.assets, 'total', 'name', TOP_NET_WORTH);
  if (a.length > 0) lines.push(`Assets: ${list(a)}.`);
  const l = rank(d.liabilities, 'total', 'name', TOP_NET_WORTH);
  if (l.length > 0) lines.push(`Liabilities: ${list(l)}.`);
  return lines.join('\n');
}

function forecast(d: Record<string, unknown>): string | null {
  const horizon = num(d.horizonMonths);
  const trailing = num(d.trailingMonths);
  const start = num(d.startingCash);
  const income = num(d.trailingMonthlyIncome);
  const expense = num(d.trailingMonthlyExpense);
  const monthlyNet = num(d.trailingMonthlyNet);
  const end = num(d.horizonEndCash);
  if (
    horizon === undefined || trailing === undefined || start === undefined || income === undefined ||
    expense === undefined || monthlyNet === undefined || end === undefined || !Array.isArray(d.projection) || d.projection.length === 0
  ) {
    return null;
  }
  const months: Array<{ month: string; cash: number }> = [];
  for (const p of d.projection) {
    if (!isRecord(p)) return null;
    const month = str(p.month);
    const cash = num(p.projectedCash);
    if (month === undefined || cash === undefined) return null;
    months.push({ month: clean(month, 10), cash });
  }
  const span = months.length === 1 ? months[0].month : `${months[0].month} to ${months[months.length - 1].month}`;
  const lines = [
    `Cash forecast for the next ${plural(horizon, 'month')} (${span}), based on the last ${plural(trailing, 'month')}.`,
    `Starting cash ${formatUsd(start)}. Average monthly income ${formatUsd(income)}, expenses ${formatUsd(expense)}, net ${formatUsd(monthlyNet)}.`,
  ];
  if (Array.isArray(d.appliedAdjustments)) {
    for (const a of d.appliedAdjustments) {
      if (!isRecord(a)) continue;
      const description = str(a.description);
      const impact = num(a.monthlyImpact);
      if (description !== undefined && impact !== undefined) lines.push(`What-if: ${clean(description, 80)} (${formatUsd(impact)} per month).`);
    }
    const adjusted = num(d.adjustedMonthlyNet);
    if (d.appliedAdjustments.length > 0 && adjusted !== undefined) lines.push(`Adjusted monthly net ${formatUsd(adjusted)}.`);
  }
  lines.push(`Projected cash: ${months.map((m) => `${m.month} ${formatUsd(m.cash)}`).join(', ')}.`);
  lines.push(`Cash at the end of the horizon: ${formatUsd(end)}.`);
  return lines.join('\n');
}

/** The answer text for one tool result, or null when the data is not shaped as that tool returns it. */
export function renderTemplate(tool: ReadToolName, data: unknown, opts: TemplateOptions): string | null {
  try {
    if (!isRecord(data)) return null;
    switch (tool) {
      case 'profit_loss':
        return profitLoss(data);
      case 'spending_summary':
        return spendingSummary(data);
      case 'transaction_search':
        return transactionSearch(data);
      case 'net_worth':
        return netWorth(data, opts);
      case 'forecast':
        return forecast(data);
      default:
        return null;
    }
  } catch {
    return null;
  }
}
