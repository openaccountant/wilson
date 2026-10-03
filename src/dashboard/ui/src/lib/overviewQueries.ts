/**
 * Overview query builders (pure, unit-tested).
 *
 * The heatmap and its day dialog read the same header filters (account,
 * entity, category — all URL-backed via useUrlState → AppState) so a cell's
 * amount and the dialog's "Total spending" always describe the same rows.
 * The dialog total uses the dashboard SPEND rule (spend-rules.ts), the same
 * rule /api/daily-spending applies server-side and in the mirror.
 *
 * No `@/` imports and no `window`, so bun tests can load it from the repo root.
 */
import { isSpend, type ClassifiableRow } from '../../../../db/spend-rules.js';

export interface OverviewFilters {
  accountId: number | null;
  entityId: number | null;
  category: string | null;
}

function filterParts(f: OverviewFilters): string[] {
  const parts: string[] = [];
  if (f.accountId != null) parts.push(`accountId=${f.accountId}`);
  if (f.entityId != null) parts.push(`entityId=${f.entityId}`);
  if (f.category) parts.push(`category=${encodeURIComponent(f.category)}`);
  return parts;
}

/** /api/daily-spending for the heatmap window, scoped to the header filters. */
export function dailySpendingPath(startDate: string, endDate: string, f: OverviewFilters): string {
  return `/api/daily-spending?${[`startDate=${startDate}`, `endDate=${endDate}`, ...filterParts(f)].join('&')}`;
}

/**
 * /api/savings scoped to account/entity. The endpoint ignores `category`
 * (a savings rate needs income and spend), so it is not sent.
 */
export function savingsPath(f: OverviewFilters): string {
  const parts = filterParts({ ...f, category: null });
  return parts.length ? `/api/savings?${parts.join('&')}` : '/api/savings';
}

/** /api/transactions for one day (the `day` URL key), or null when no day is open. */
export function dayTransactionsPath(day: string | null, f: OverviewFilters, limit = 50): string | null {
  if (!day) return null;
  return `/api/transactions?${[`start=${day}`, `end=${day}`, `limit=${limit}`, ...filterParts(f)].join('&')}`;
}

/** Sum of |amount| over SPEND rows (excludes transfers, card payments, negative income). */
export function daySpendTotal(rows: readonly ClassifiableRow[]): number {
  let total = 0;
  for (const r of rows) if (isSpend(r)) total += Math.abs(r.amount);
  return total;
}

/**
 * /api/streak and /api/weekly-summary scoped to the header entity. Only the
 * entity applies (the endpoints are all-time / fixed-window cards with no
 * account or category params); the streak's daily budget stays all-budgets.
 */
export function entityScopedPath(path: '/api/streak' | '/api/weekly-summary', entityId: number | null): string {
  return entityId != null ? `${path}?entityId=${entityId}` : path;
}
