// ── Offline mirror: read-tool executors ──────────────────────────────────────
//
// Async mirror counterparts of the dashboard's READ tools (spec D4, §7.1):
// transaction_search, spending_summary, profit_loss. Each returns the same
// `.data` payload the real server tool returns (what executeRead hands back
// after unwrapping `{data}`), computed from the wa-sqlite mirror with the clock
// injected. Period math, the natural-language parser and the formatters are the
// zero-import copies in src/tools/read-core/; the SQL is the shared composers
// (db/transaction-where.ts, db/overview-sql.ts). Parity is pinned by
// src/__tests__/mirror-tool-parity.test.ts against the real server tools.
//
// net_worth (summary, balance_sheet) and forecast read accounts / loans (mirror
// v4, phase 2). net_worth `trend` stays server-only (licensed; DECISIONS Q2) and
// resolves `servable:false, why:'licensed'`. On a mirror whose v4 tables are
// missing, both resolve `servable:false, why:'missing-tables'`.
//
// Pure module: no browser glue, no bun:sqlite.

import { CATEGORIES } from '../../../../tools/categorize/categories.js';
import {
  getPeriodDatesAt,
  parseNaturalQueryAt,
  formatSearchResults,
  formatSpendingSummary,
  formatPnl,
  type ReadPeriod,
} from '../../../../tools/read-core/index.js';
import type { SpendingSummaryRow } from '../../../../db/overview-sql.js';
import { mirrorGetTransactions } from './mirror-reads.js';
import { mirrorGetSpendingSummary, mirrorGetProfitLoss } from './mirror-overview.js';
import { mirrorNetWorth, type NetWorthAction } from './mirror-networth.js';
import { mirrorForecast } from './mirror-forecast.js';
import type { ForecastParams, ForecastResult } from '../../../../tools/read-core/forecast-math.js';
import type { SqliteBinding } from './types.js';

/** The five READ tools of src/mcp/tool-catalog.ts. */
export const READ_TOOL_NAMES = ['transaction_search', 'spending_summary', 'profit_loss', 'net_worth', 'forecast'] as const;
export type ReadToolName = (typeof READ_TOOL_NAMES)[number];

/** Read tools the v4 mirror can serve (net_worth: summary and balance_sheet only). */
export const SERVABLE_READ_TOOLS: ReadToolName[] = ['transaction_search', 'spending_summary', 'profit_loss', 'net_worth', 'forecast'];

export type ToolReadResult =
  | { servable: false; why: 'not-seeded' | 'missing-tables' | 'unsupported-args' | 'licensed' }
  | { servable: true; data: unknown; summary: string; profile: string };

/** Per-step summary cap (spec §8.3). */
export const SUMMARY_MAX_CHARS = 1_200;
/** transaction_search summary shows at most this many rows (spec §8.3). */
export const SUMMARY_MAX_ROWS = 25;
const SUMMARY_DESCRIPTION_MAX = 80;

/**
 * Category names for the NL parser: `SELECT name FROM categories` in the same
 * order as the server's getCategories, falling back to the built-in list when
 * the table is empty or missing (server parity).
 */
export async function mirrorCategoryNames(db: SqliteBinding): Promise<string[]> {
  try {
    const rows = await db.prepare('SELECT name FROM categories ORDER BY sort_order ASC, name ASC').all();
    if (rows.length > 0) return rows.map((r) => String(r.name));
  } catch {
    // categories table may not exist
  }
  return CATEGORIES;
}

function capText(text: string, max: number = SUMMARY_MAX_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function money(amount: number): string {
  return amount < 0 ? `-$${Math.abs(amount).toFixed(2)}` : `+$${amount.toFixed(2)}`;
}

// ── transaction_search ───────────────────────────────────────────────────────

interface SearchRow {
  id: number;
  date: string;
  description: string;
  amount: number;
  category: string | null;
}

export async function mirrorTransactionSearch(db: SqliteBinding, query: string, now: Date) {
  const filters = parseNaturalQueryAt(query, now, await mirrorCategoryNames(db));
  const transactions = (await mirrorGetTransactions(db, filters)) as unknown as SearchRow[];
  const formatted = formatSearchResults(transactions);
  return {
    query,
    filtersApplied: filters,
    count: transactions.length,
    formatted,
    transactions: transactions.slice(0, 100).map((t) => ({
      id: t.id,
      date: t.date,
      description: t.description,
      amount: t.amount,
      category: t.category,
    })),
  };
}

function summarizeSearch(data: Awaited<ReturnType<typeof mirrorTransactionSearch>>): string {
  if (data.count === 0) return 'No transactions found matching your query.';
  const head = `Found ${data.count} transaction${data.count === 1 ? '' : 's'}. Filters: ${JSON.stringify(data.filtersApplied)}`;
  const total = data.transactions.reduce((sum, t) => sum + t.amount, 0);
  const lines: string[] = [];
  let used = head.length + 1;
  const shown = data.transactions.slice(0, SUMMARY_MAX_ROWS);
  const tail = (omitted: number) => `(+${omitted} more) Total of listed rows: ${money(total)}`;
  for (const t of shown) {
    const desc = t.description.length > SUMMARY_DESCRIPTION_MAX ? `${t.description.slice(0, SUMMARY_DESCRIPTION_MAX - 1)}…` : t.description;
    const line = `#${t.id} ${t.date} ${money(t.amount)} ${t.category ?? 'Uncategorized'} ${desc}`;
    if (used + line.length + 1 + tail(data.count).length + 1 > SUMMARY_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  const omitted = data.count - lines.length;
  return capText([head, ...lines, ...(omitted > 0 ? [tail(omitted)] : [])].join('\n'));
}

// ── spending_summary ─────────────────────────────────────────────────────────

export async function mirrorSpendingSummary(
  db: SqliteBinding,
  args: { period: ReadPeriod; compareWithPrevious: boolean },
  now: Date
) {
  const current = getPeriodDatesAt(args.period, 0, now);
  const currentRows = await mirrorGetSpendingSummary(db, current.start, current.end);

  let prevRows: SpendingSummaryRow[] | undefined;
  let prevLabel: string | undefined;
  if (args.compareWithPrevious) {
    const prev = getPeriodDatesAt(args.period, -1, now);
    prevRows = await mirrorGetSpendingSummary(db, prev.start, prev.end);
    prevLabel = prev.label;
  }

  const formatted = formatSpendingSummary(currentRows, current.label, prevRows, prevLabel);
  const grandTotal = currentRows.reduce((sum, r) => sum + r.total, 0);
  const transactionCount = currentRows.reduce((sum, r) => sum + r.count, 0);

  return {
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
  };
}

// ── profit_loss ──────────────────────────────────────────────────────────────

export async function mirrorProfitLoss(
  db: SqliteBinding,
  args: { period: ReadPeriod; offset: number },
  now: Date
) {
  const { start, end, label } = getPeriodDatesAt(args.period, args.offset, now);
  const pnl = await mirrorGetProfitLoss(db, start, end);
  const formatted = formatPnl(pnl, label);
  return {
    period: label,
    dateRange: { start, end },
    ...pnl,
    formatted,
  };
}

// ── net_worth / forecast summaries ──────────────────────────────────────────

function usd(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function summarizeNetWorth(data: Record<string, unknown>): string {
  if (typeof data.message === 'string') return data.message;
  const lines: string[] = [];
  lines.push(`Net worth: ${usd(Number(data.netWorth))}`);
  if (typeof data.totalAssets === 'number') lines.push(`Total assets: ${usd(data.totalAssets)}`);
  if (typeof data.totalLiabilities === 'number') lines.push(`Total liabilities: ${usd(data.totalLiabilities)}`);
  const group = (title: string, rows: unknown) => {
    if (!Array.isArray(rows) || rows.length === 0) return;
    lines.push(`${title}:`);
    for (const r of rows as Array<Record<string, unknown>>) {
      // summary rows are {subtype,total,count}; balance_sheet rows are {name,subtype,balance}
      if (typeof r.total === 'number') lines.push(`- ${String(r.subtype)}: ${usd(r.total)} (${String(r.count)})`);
      else lines.push(`- ${String(r.name)} (${String(r.subtype)}): ${usd(Number(r.balance))}`);
    }
  };
  group('Assets', data.assets);
  group('Liabilities', data.liabilities);
  if (Array.isArray(data.equity) && data.equity.length > 0) {
    lines.push('Equity:');
    for (const e of data.equity as Array<Record<string, unknown>>) {
      lines.push(`- ${String(e.assetName)}: value ${usd(Number(e.assetValue))}, loan ${usd(Number(e.loanBalance))}, equity ${usd(Number(e.equity))} (${String(e.equityPercent)}%)`);
    }
  }
  return capText(lines.join('\n'));
}

function summarizeForecast(f: ForecastResult): string {
  const lines = [
    `Forecast: ${f.horizonMonths} months ahead, based on the last ${f.trailingMonths} months`,
    `Starting cash: ${usd(f.startingCash)}`,
    `Average monthly income: ${usd(f.trailingMonthlyIncome)}`,
    `Average monthly expenses: ${usd(f.trailingMonthlyExpense)}`,
    `Average monthly net: ${usd(f.trailingMonthlyNet)}`,
  ];
  for (const a of f.appliedAdjustments) lines.push(`What-if: ${a.description} -> ${usd(a.monthlyImpact)}/mo`);
  if (f.appliedAdjustments.length > 0) lines.push(`Adjusted monthly net: ${usd(f.adjustedMonthlyNet)}`);
  for (const p of f.projection) lines.push(`${p.month}: ${usd(p.projectedCash)}`);
  lines.push(`Cash at the end of the horizon: ${usd(f.horizonEndCash)}`);
  return capText(lines.join('\n'));
}

/** Validate forecast args the way the zod shape does (and no looser); null when unusable. */
function parseForecastArgs(args: Record<string, unknown>): ForecastParams | null {
  const num = (v: unknown): number | undefined | null =>
    v === undefined ? undefined : typeof v === 'number' && Number.isFinite(v) ? v : null;
  const trailingMonths = num(args.trailingMonths);
  const horizonMonths = num(args.horizonMonths);
  if (trailingMonths === null || horizonMonths === null) return null;
  const params: ForecastParams = {};
  if (trailingMonths !== undefined) params.trailingMonths = trailingMonths;
  if (horizonMonths !== undefined) params.horizonMonths = horizonMonths;
  if (args.whatIf !== undefined) {
    if (!Array.isArray(args.whatIf)) return null;
    const whatIf: NonNullable<ForecastParams['whatIf']> = [];
    for (const w of args.whatIf) {
      if (!isRecord(w) || (w.type !== 'adjust_category' && w.type !== 'drop_recurring')) return null;
      const delta = num(w.monthlyDelta);
      if (delta === null) return null;
      if (w.category !== undefined && typeof w.category !== 'string') return null;
      if (w.description !== undefined && typeof w.description !== 'string') return null;
      whatIf.push({
        type: w.type,
        ...(w.category !== undefined ? { category: w.category as string } : {}),
        ...(delta !== undefined ? { monthlyDelta: delta } : {}),
        ...(w.description !== undefined ? { description: w.description as string } : {}),
      });
    }
    params.whatIf = whatIf;
  }
  return params;
}

function isMissingTable(err: unknown): boolean {
  return /no such table/i.test(err instanceof Error ? err.message : String(err));
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

const PERIODS: readonly string[] = ['month', 'quarter', 'year'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Execute one READ tool against the mirror. `args` are the catalog args
 * (optional fields may be absent); schema defaults are applied EXPLICITLY here
 * (the server tools never apply them, see mirror-tool-divergence.test.ts).
 * `profile` is the mirror profile this read ran against; it is echoed on every
 * servable result so the caller can detect a mid-run profile switch.
 *
 * Never throws for bad input: unusable args resolve `unsupported-args`.
 */
export async function mirrorExecuteRead(
  db: SqliteBinding,
  tool: ReadToolName,
  args: Record<string, unknown>,
  now: Date,
  profile: string
): Promise<ToolReadResult> {
  if (!isRecord(args)) return { servable: false, why: 'unsupported-args' };

  switch (tool) {
    case 'transaction_search': {
      if (typeof args.query !== 'string') return { servable: false, why: 'unsupported-args' };
      const data = await mirrorTransactionSearch(db, args.query, now);
      return { servable: true, data, summary: summarizeSearch(data), profile };
    }
    case 'spending_summary': {
      const period = args.period ?? 'month';
      const compare = args.compareWithPrevious ?? true;
      if (typeof period !== 'string' || !PERIODS.includes(period) || typeof compare !== 'boolean') {
        return { servable: false, why: 'unsupported-args' };
      }
      const data = await mirrorSpendingSummary(db, { period: period as ReadPeriod, compareWithPrevious: compare }, now);
      return { servable: true, data, summary: capText(data.formatted), profile };
    }
    case 'profit_loss': {
      const period = args.period ?? 'month';
      const offset = args.offset ?? 0;
      if (typeof period !== 'string' || !PERIODS.includes(period) || typeof offset !== 'number' || !Number.isFinite(offset)) {
        return { servable: false, why: 'unsupported-args' };
      }
      const data = await mirrorProfitLoss(db, { period: period as ReadPeriod, offset }, now);
      return { servable: true, data, summary: capText(data.formatted), profile };
    }
    case 'net_worth': {
      const action = args.action;
      // trend is licensed server-side; never served from the mirror (DECISIONS Q2).
      if (action === 'trend') return { servable: false, why: 'licensed' };
      if (action !== 'summary' && action !== 'balance_sheet') return { servable: false, why: 'unsupported-args' };
      try {
        const data = await mirrorNetWorth(db, action as NetWorthAction);
        return { servable: true, data, summary: summarizeNetWorth(data), profile };
      } catch (err) {
        if (isMissingTable(err)) return { servable: false, why: 'missing-tables' };
        throw err;
      }
    }
    case 'forecast': {
      const params = parseForecastArgs(args);
      if (!params) return { servable: false, why: 'unsupported-args' };
      try {
        const data = await mirrorForecast(db, params, now);
        return { servable: true, data, summary: summarizeForecast(data), profile };
      } catch (err) {
        if (isMissingTable(err)) return { servable: false, why: 'missing-tables' };
        throw err;
      }
    }
    default:
      return { servable: false, why: 'unsupported-args' };
  }
}
