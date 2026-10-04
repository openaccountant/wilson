// ── Shared overview query-param parsing ──────────────────────────────────────
//
// Extracted verbatim from the overview handlers in api.ts so the server
// endpoints and the offline mirror's `serveApiPath` parse the exact same query
// params — including the edge behaviors (e.g. a 200-shaped `{ error }` object
// when /api/daily-spending lacks params). Parity means replicating these
// behaviors, not fixing them.
//
// Import-safe for the dashboard UI bundle: imports only the zero-import
// spend-rules module and a type from overview-sql.

import { DASHBOARD_RULES } from '../db/spend-rules.js';
import type { OverviewOptions } from '../db/overview-sql.js';

export function parseAccountId(params: URLSearchParams): number | undefined {
  const val = params.get('accountId');
  return val ? parseInt(val, 10) : undefined;
}

export function parseEntityId(params: URLSearchParams): number | undefined {
  const val = params.get('entityId');
  return val ? parseInt(val, 10) : undefined;
}

/**
 * Resolve the [startDate, endDate] window for the summary/pnl/budgets
 * endpoints: explicit startDate+endDate slice the month containing them;
 * otherwise the `month` param (default: the current UTC month) spans the
 * whole calendar month.
 */
export function parseDateRange(params: URLSearchParams) {
  const directStart = params.get('startDate');
  const directEnd = params.get('endDate');
  if (directStart && directEnd) {
    const month = directStart.slice(0, 7);
    return { month, startDate: directStart, endDate: directEnd };
  }
  const month = params.get('month') ?? new Date().toISOString().slice(0, 7);
  const [year, mon] = month.split('-').map(Number);
  const startDate = `${month}-01`;
  const endDate = new Date(year, mon, 0).toISOString().slice(0, 10);
  return { month, startDate, endDate };
}

/** /api/savings — number of trailing months (default 6). */
export function parseSavingsMonths(params: URLSearchParams): number {
  return parseInt(params.get('months') ?? '6', 10);
}

/** /api/budget-countdown — the YYYY-MM to count down (default: current UTC month). */
export function parseBudgetCountdownMonth(params: URLSearchParams): string {
  return params.get('month') ?? new Date().toISOString().slice(0, 7);
}

export type DailySpendingRange = { startDate: string; endDate: string } | { error: string };

/**
 * /api/daily-spending — both dates are required; the endpoint answers 200
 * with `{ error }` when either is missing (replicated exactly).
 */
export function parseDailySpendingRange(params: URLSearchParams): DailySpendingRange {
  const startDate = params.get('startDate');
  const endDate = params.get('endDate');
  if (!startDate || !endDate) {
    return { error: 'startDate and endDate required' };
  }
  return { startDate, endDate };
}

/**
 * The dashboard aggregation options for a request: every dashboard rule on
 * (spend-rules.ts) plus the optional exact `category` filter. Only dashboard
 * endpoints and the mirror build these — CLI callers never pass options.
 */
export function parseDashboardOptions(params: URLSearchParams): OverviewOptions {
  const category = params.get('category');
  return category ? { ...DASHBOARD_RULES, category } : { ...DASHBOARD_RULES };
}

/**
 * /api/net-worth/trend — trailing months, default 12. Garbage (`months=abc`)
 * falls back to the default and the value is clamped to [1, 360] so the
 * date math can never produce an Invalid Date (which used to 500).
 */
export function parseNetWorthMonths(params: URLSearchParams): number {
  const parsed = parseInt(params.get('months') ?? '12', 10);
  if (!Number.isFinite(parsed)) return 12;
  return Math.min(360, Math.max(1, parsed));
}