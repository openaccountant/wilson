/**
 * Typed client side of the spending drill-down endpoints (pure: types + path
 * builders, no fetch, no `@/` alias, no `window` — bun tests load it).
 *
 * Contract (all GET, dashboard spend rules, spendOnly, mirrored offline):
 *
 *   GET /api/spending/breakdown?startDate&endDate&accountId&entityId&cat
 *       &merchant&by=category|merchant|detailed&limit=12&offset=0
 *       &compareStart&compareEnd
 *     → BreakdownResponse (+ by, groupCount, top-level prevTotal,
 *       otherTxnCount). No cat → rows grouped by category label
 *       (COALESCE … 'Uncategorized'); cat → grouped by merchant key
 *       COALESCE(NULLIF(TRIM(merchant_name),''), description), or by
 *       category_detailed when by=detailed. Amounts are POSITIVE spend.
 *       `merchant` here is the EXACT merchant key.
 *
 *   GET /api/spending/series?startDate&endDate&interval=month&cat&merchant
 *       &accountId&entityId
 *     → SeriesResponse: null for months outside unfiltered coverage, 0 for
 *       covered months with no matching spend.
 *
 * The L3 transaction table reads /api/transactions with `merchantExact` —
 * NEVER `merchant`, which on that endpoint is a fuzzy description LIKE.
 */

import type { SpendingBreakdownBy as BreakdownBy } from '../types';

// The response shapes are the server's own (types.ts mirrors
// SpendingBreakdownResult / SpendingSeriesResult in db/spending-drill-sql.ts);
// these aliases keep the drill code's short names.
export type {
  SpendingBreakdownBy as BreakdownBy,
  SpendingBreakdownRow as BreakdownRow,
  SpendingBreakdownResponse as BreakdownResponse,
  SpendingSeriesResponse as SeriesResponse,
} from '../types';

export interface SpendingScope {
  startDate: string;
  endDate: string;
  accountId?: number | null;
  entityId?: number | null;
  cat?: string | null;
  /** Exact merchant key. */
  merchant?: string | null;
}

export interface BreakdownQuery extends SpendingScope {
  by?: BreakdownBy;
  limit?: number;
  offset?: number;
  compareStart?: string | null;
  compareEnd?: string | null;
}

function scopeParts(q: SpendingScope): string[] {
  const parts = [`startDate=${q.startDate}`, `endDate=${q.endDate}`];
  if (q.accountId != null) parts.push(`accountId=${q.accountId}`);
  if (q.entityId != null) parts.push(`entityId=${q.entityId}`);
  if (q.cat) parts.push(`cat=${encodeURIComponent(q.cat)}`);
  if (q.merchant) parts.push(`merchant=${encodeURIComponent(q.merchant)}`);
  return parts;
}

export function breakdownPath(q: BreakdownQuery): string {
  const parts = scopeParts(q);
  if (q.by) parts.push(`by=${q.by}`);
  if (q.limit != null) parts.push(`limit=${q.limit}`);
  if (q.offset) parts.push(`offset=${q.offset}`);
  if (q.compareStart && q.compareEnd) {
    parts.push(`compareStart=${q.compareStart}`, `compareEnd=${q.compareEnd}`);
  }
  return `/api/spending/breakdown?${parts.join('&')}`;
}

export function seriesPath(q: SpendingScope): string {
  return `/api/spending/series?${[...scopeParts(q), 'interval=month'].join('&')}`;
}

export interface MerchantTransactionsQuery {
  startDate: string;
  endDate: string;
  merchant: string;
  cat?: string | null;
  accountId?: number | null;
  entityId?: number | null;
  /** 0-based page. */
  page: number;
  pageSize?: number;
}

export const TXN_PAGE_SIZE = 50;

/**
 * One page of the L3 table: the drill's merchant key goes out as
 * `merchantExact` (exact label match) with spendOnly, so the rows are exactly
 * the ones the breakdown summed.
 */
export function merchantTransactionsPath(q: MerchantTransactionsQuery): string {
  const size = q.pageSize ?? TXN_PAGE_SIZE;
  const parts = [
    `startDate=${q.startDate}`,
    `endDate=${q.endDate}`,
    `merchantExact=${encodeURIComponent(q.merchant)}`,
    'spendOnly=1',
    `limit=${size}`,
    `offset=${Math.max(0, q.page) * size}`,
  ];
  if (q.cat) parts.push(`category=${encodeURIComponent(q.cat)}`);
  if (q.accountId != null) parts.push(`accountId=${q.accountId}`);
  if (q.entityId != null) parts.push(`entityId=${q.entityId}`);
  return `/api/transactions?${parts.join('&')}`;
}

export function pageCount(total: number, pageSize = TXN_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}
