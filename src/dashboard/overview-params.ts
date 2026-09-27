// ── Shared overview query-param parsing ──────────────────────────────────────
//
// Extracted verbatim from the overview handlers in api.ts so the server
// endpoints and the offline mirror's `serveApiPath` parse the exact same query
// params — including the edge behaviors (e.g. a 200-shaped `{ error }` object
// when /api/daily-spending lacks params). Parity means replicating these
// behaviors, not fixing them.
//
// Import-safe for the dashboard UI bundle: ZERO imports.

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