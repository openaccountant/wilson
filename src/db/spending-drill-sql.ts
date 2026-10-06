// ── Spending drill: shared SQL composers + drivers ───────────────────────────
//
// The single source for GET /api/spending/breakdown and GET
// /api/spending/series. The server handlers (src/dashboard/api.ts) and the
// offline mirror (src/dashboard/ui/src/store/mirror-reads.ts) both call the
// SAME async drivers below over a structural OverviewQueryable — the server's
// sync compat Database and the mirror's promise-based SqliteBinding both fit
// (results are awaited unconditionally) — so the two sides cannot drift in SQL,
// shaping, or rounding. src/__tests__/spending-drill-parity.test.ts still
// deep-equals serveApiPath output against the real handlers per endpoint.
//
// DASHBOARD-ONLY: every query applies the dashboard spend rules
// (spend-rules.ts DASHBOARD_RULES via transaction-where.ts, spendOnly), so no
// CLI tool, report or goal ever runs this SQL.
//
// Import-safe for the dashboard UI bundle: imports only the zero-import
// spend-rules / compare-window / pfc-taxonomy modules plus transaction-where
// and overview-sql (both bundle-safe). No bun:sqlite, no browser APIs.

import {
  categoryLabelSql,
  merchantLabelSql,
  DASHBOARD_RULES,
  INCOME_CATEGORY,
  NON_SPEND_CATEGORIES,
} from './spend-rules.js';
import { buildTransactionConditions, type TransactionFilters } from './transaction-where.js';
import {
  COVERAGE_MONTHS_SQL,
  COVERAGE_RANGE_SQL,
  toCoverage,
  type CoverageResult,
  type OverviewQueryable,
  type SqlParams,
} from './overview-sql.js';
import { monthSpan, trailingMonthsWindow, windowHasCoverage, type DateWindow } from './compare-window.js';
import { getDisplayName, PFC_PRIMARY } from '../categories/pfc-taxonomy.js';

// ── Query shapes (produced by src/dashboard/spending-params.ts) ─────────────

export type BreakdownBy = 'category' | 'merchant' | 'detailed';

/** Filters common to both drill endpoints. */
export interface DrillFilters {
  startDate?: string;
  endDate?: string;
  accountId?: number;
  entityId?: number;
  /** Exact category label ('Uncategorized' = NULL/blank/'Uncategorized'). */
  cat?: string;
  /** Exact merchant key (merchantExact — NEVER the fuzzy description LIKE). */
  merchant?: string;
}

export interface BreakdownQuery extends DrillFilters {
  by: BreakdownBy;
  limit: number;
  offset: number;
  compare?: DateWindow;
}

export interface SeriesQuery extends DrillFilters {
  interval: 'month';
}

// ── Response shapes ──────────────────────────────────────────────────────────

export interface BreakdownRow {
  /** Group key: category label, merchant key, or category_detailed ('' = none). */
  key: string;
  /** Display label (PFC detailed codes humanized; '' detail → 'No detail'). */
  label: string;
  /** Positive spend in the range. */
  total: number;
  /** Transactions in the group. */
  count: number;
  /** Latest transaction date in the group (YYYY-MM-DD). */
  last: string;
  /**
   * Positive spend for this key in the comparison window: null when no
   * comparison was requested OR the comparison window has no data coverage;
   * 0 when covered but the key had no spend there.
   */
  prevTotal: number | null;
}

export interface SpendingBreakdownResult {
  /** The grouping actually applied (default: category, or merchant when cat is set). */
  by: BreakdownBy;
  /** Positive spend across ALL groups. */
  total: number;
  /** Spend transactions across all groups. */
  count: number;
  /** Distinct groups across the whole range (for 'N more' labels). */
  groupCount: number;
  /**
   * Positive outflows EXCLUDED from spend as transfers & card payments: rows
   * with amount < 0 whose category is a non-spend label other than 'Income',
   * under the same date/account/entity/cat/merchant filters.
   */
  excludedTotal: number;
  /** Total spend in the comparison window (null: none requested / no coverage). */
  prevTotal: number | null;
  /** The page of groups, ranked by total DESC (key ASC breaks ties). */
  rows: BreakdownRow[];
  /** Spend of the groups ranked AFTER this page (offset + limit onward). */
  otherTotal: number;
  /** Number of groups ranked after this page. */
  otherCount: number;
  /** Transactions in the groups ranked after this page. */
  otherTxnCount: number;
  /** More than one distinct non-blank category_detailed among the filtered spend. */
  hasDetailed: boolean;
}

export interface SpendingSeriesResult {
  /** Every YYYY-MM from the start month to the end month. */
  periods: string[];
  /** Spend per period: null outside unfiltered coverage, 0 inside with no spend. */
  values: (number | null)[];
  coverageStart: string | null;
  coverageEnd: string | null;
}

// ── SQL pieces ───────────────────────────────────────────────────────────────

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Non-spend labels that are transfers / card payments (Income is not). */
export const EXCLUDED_TRANSFER_CATEGORIES: readonly string[] = Object.freeze(
  NON_SPEND_CATEGORIES.filter((c) => c !== INCOME_CATEGORY)
);

const EXCLUDED_TRANSFER_SQL_LIST = EXCLUDED_TRANSFER_CATEGORIES.map(quote).join(', ');

/** The GROUP BY key expression for a breakdown grouping. */
export function breakdownKeySql(by: BreakdownBy): string {
  switch (by) {
    case 'merchant':
      // Same label merchantExact matches, so a row key drills losslessly.
      return merchantLabelSql();
    case 'detailed':
      return `COALESCE(NULLIF(TRIM(category_detailed), ''), '')`;
    case 'category':
    default:
      return categoryLabelSql();
  }
}

/** Shared WHERE for the drill (dashboard rules; spendOnly unless `spend` false). */
export function drillConditions(
  f: DrillFilters,
  opts: { spend?: boolean; window?: DateWindow } = {}
): { conditions: string[]; params: SqlParams } {
  const filters: TransactionFilters = {
    dateStart: opts.window ? opts.window.start : f.startDate,
    dateEnd: opts.window ? opts.window.end : f.endDate,
    accountId: f.accountId,
    entityId: f.entityId,
    category: f.cat,
    merchantExact: f.merchant,
    spendOnly: opts.spend !== false,
  };
  const { conditions, params } = buildTransactionConditions(filters, DASHBOARD_RULES);
  if (conditions.length === 0) conditions.push('1 = 1');
  return { conditions, params };
}

/** Grouped spend (key, total, count, last), ranked, as a subquery body. */
function groupedSql(by: BreakdownBy, where: string): string {
  const key = breakdownKeySql(by);
  return `
    SELECT ${key} AS key, SUM(-amount) AS total, COUNT(*) AS count, MAX(date) AS last
    FROM transactions
    WHERE ${where}
    GROUP BY ${key}
    ORDER BY total DESC, key ASC`;
}

export interface BreakdownSql {
  totals: { sql: string; params: SqlParams };
  page: { sql: string; params: SqlParams };
  rest: { sql: string; params: SqlParams };
  excluded: { sql: string; params: SqlParams };
  detailed: { sql: string; params: SqlParams };
}

/** Every statement the breakdown runs for the CURRENT range. */
export function composeBreakdownSql(q: BreakdownQuery): BreakdownSql {
  const spend = drillConditions(q);
  const where = spend.conditions.join(' AND ');
  const key = breakdownKeySql(q.by);

  const totals = {
    sql: `
    SELECT COALESCE(SUM(-amount), 0) AS total, COUNT(*) AS count, COUNT(DISTINCT ${key}) AS groups
    FROM transactions
    WHERE ${where}`,
    params: spend.params,
  };
  const page = {
    sql: `${groupedSql(q.by, where)}
    LIMIT @limit OFFSET @offset`,
    params: { ...spend.params, limit: q.limit, offset: q.offset },
  };
  const rest = {
    sql: `
    SELECT COALESCE(SUM(total), 0) AS total, COALESCE(SUM(count), 0) AS count, COUNT(*) AS groups
    FROM (${groupedSql(q.by, where)}
      LIMIT -1 OFFSET @restOffset)`,
    params: { ...spend.params, restOffset: q.offset + q.limit },
  };

  const all = drillConditions(q, { spend: false });
  const excluded = {
    sql: `
    SELECT COALESCE(SUM(-amount), 0) AS total
    FROM transactions
    WHERE ${[...all.conditions, 'amount < 0', `COALESCE(category, '') IN (${EXCLUDED_TRANSFER_SQL_LIST})`].join(' AND ')}`,
    params: all.params,
  };
  const detailed = {
    sql: `
    SELECT COUNT(DISTINCT NULLIF(TRIM(category_detailed), '')) AS n
    FROM transactions
    WHERE ${where}`,
    params: spend.params,
  };
  return { totals, page, rest, excluded, detailed };
}

/** Comparison-window statements: the total, and per-key totals for `keys`. */
export function composeBreakdownCompareSql(
  q: BreakdownQuery,
  window: DateWindow,
  keys: string[]
): { total: { sql: string; params: SqlParams }; byKey: { sql: string; params: SqlParams } | null } {
  const spend = drillConditions(q, { window });
  const where = spend.conditions.join(' AND ');
  const total = {
    sql: `
    SELECT COALESCE(SUM(-amount), 0) AS total
    FROM transactions
    WHERE ${where}`,
    params: spend.params,
  };
  if (keys.length === 0) return { total, byKey: null };
  const key = breakdownKeySql(q.by);
  const keyParams: SqlParams = {};
  const placeholders = keys.map((k, i) => {
    keyParams[`k${i}`] = k;
    return `@k${i}`;
  });
  const byKey = {
    sql: `
    SELECT ${key} AS key, SUM(-amount) AS total
    FROM transactions
    WHERE ${where} AND ${key} IN (${placeholders.join(', ')})
    GROUP BY ${key}`,
    params: { ...spend.params, ...keyParams },
  };
  return { total, byKey };
}

/** Monthly spend for the series (months with no spend are simply absent). */
export function composeSeriesSql(q: SeriesQuery, window: DateWindow): { sql: string; params: SqlParams } {
  const spend = drillConditions(q, { window });
  return {
    sql: `
    SELECT substr(date, 1, 7) AS month, SUM(-amount) AS total
    FROM transactions
    WHERE ${spend.conditions.join(' AND ')}
    GROUP BY substr(date, 1, 7)`,
    params: spend.params,
  };
}

// ── Pure shaping ─────────────────────────────────────────────────────────────

/** Round to cents (sums of REAL amounts drift: 0.1 + 0.2). Never -0. */
export function roundMoney(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n ?? 0);
  if (!Number.isFinite(v)) return 0;
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}

const PFC_CODE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const PFC_PRIMARY_SET = new Set<string>(PFC_PRIMARY);

/**
 * Label for a 'detailed' key: PFC codes humanized (FOOD_AND_DRINK_GROCERIES →
 * 'Groceries'; a bare primary such as TRAVEL → 'Travel'), free-form values
 * kept verbatim, '' → 'No detail'.
 */
export function detailedLabel(key: string): string {
  if (key === '') return 'No detail';
  if (PFC_PRIMARY_SET.has(key) || PFC_CODE_RE.test(key)) return getDisplayName(key);
  return key;
}

export function breakdownLabel(by: BreakdownBy, key: string): string {
  return by === 'detailed' ? detailedLabel(key) : key;
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

// ── Drivers (one implementation for server AND mirror) ──────────────────────

async function readCoverage(db: OverviewQueryable): Promise<CoverageResult> {
  const range = (await db.prepare(COVERAGE_RANGE_SQL).get()) as { first_date?: unknown; last_date?: unknown } | undefined;
  const months = (await db.prepare(COVERAGE_MONTHS_SQL).all()) as { month?: unknown }[];
  return toCoverage(range, months);
}

/** GET /api/spending/breakdown over any OverviewQueryable. */
export async function runSpendingBreakdown(
  db: OverviewQueryable,
  q: BreakdownQuery
): Promise<SpendingBreakdownResult> {
  const s = composeBreakdownSql(q);
  const totals = (await db.prepare(s.totals.sql).get(s.totals.params)) ?? {};
  const pageRows = await db.prepare(s.page.sql).all(s.page.params);
  const rest = (await db.prepare(s.rest.sql).get(s.rest.params)) ?? {};
  const excluded = (await db.prepare(s.excluded.sql).get(s.excluded.params)) ?? {};
  const detailed = (await db.prepare(s.detailed.sql).get(s.detailed.params)) ?? {};

  const keys = pageRows.map((r) => str(r.key));

  let prevTotal: number | null = null;
  let prevByKey: Map<string, number> | null = null;
  if (q.compare) {
    const coverage = await readCoverage(db);
    if (windowHasCoverage(q.compare, coverage)) {
      const c = composeBreakdownCompareSql(q, q.compare, keys);
      const t = (await db.prepare(c.total.sql).get(c.total.params)) ?? {};
      prevTotal = roundMoney(t.total);
      prevByKey = new Map();
      if (c.byKey) {
        for (const r of await db.prepare(c.byKey.sql).all(c.byKey.params)) {
          prevByKey.set(str(r.key), roundMoney(r.total));
        }
      }
    }
  }

  const rows: BreakdownRow[] = pageRows.map((r) => {
    const key = str(r.key);
    return {
      key,
      label: breakdownLabel(q.by, key),
      total: roundMoney(r.total),
      count: num(r.count),
      last: str(r.last),
      prevTotal: prevByKey ? (prevByKey.get(key) ?? 0) : null,
    };
  });

  return {
    by: q.by,
    total: roundMoney(totals.total),
    count: num(totals.count),
    groupCount: num(totals.groups),
    excludedTotal: roundMoney(excluded.total),
    prevTotal,
    rows,
    otherTotal: roundMoney(rest.total),
    otherCount: num(rest.groups),
    otherTxnCount: num(rest.count),
    hasDetailed: num(detailed.n) > 1,
  };
}

/**
 * Resolve the series window: the explicit [startDate, endDate], else the
 * trailing 12 months ending at the coverage end month; null when neither
 * exists (nothing imported and no dates given).
 */
export function seriesWindow(q: SeriesQuery, coverage: CoverageResult): DateWindow | null {
  if (q.startDate && q.endDate) return { start: q.startDate, end: q.endDate };
  return coverage.end ? trailingMonthsWindow(coverage.end, 12) : null;
}

/** Pure: monthly totals + coverage → the series contract. */
export function toSpendingSeries(
  window: DateWindow | null,
  monthTotals: { month?: unknown; total?: unknown }[],
  coverage: CoverageResult
): SpendingSeriesResult {
  const periods = window ? monthSpan(window.start.slice(0, 7), window.end.slice(0, 7)) : [];
  const byMonth = new Map(monthTotals.map((r) => [str(r.month), roundMoney(r.total)]));
  const covered = new Set(coverage.months);
  return {
    periods,
    values: periods.map((m) => (covered.has(m) ? (byMonth.get(m) ?? 0) : null)),
    coverageStart: coverage.start,
    coverageEnd: coverage.end,
  };
}

/** GET /api/spending/series over any OverviewQueryable. */
export async function runSpendingSeries(db: OverviewQueryable, q: SeriesQuery): Promise<SpendingSeriesResult> {
  const coverage = await readCoverage(db);
  const window = seriesWindow(q, coverage);
  if (!window) return toSpendingSeries(null, [], coverage);
  const { sql, params } = composeSeriesSql(q, window);
  const rows = (await db.prepare(sql).all(params)) as { month?: unknown; total?: unknown }[];
  return toSpendingSeries(window, rows, coverage);
}
