// ── Offline mirror: read layer ───────────────────────────────────────────────
//
// Serves the endpoints the dashboard tabs read offline, with parity to the
// server: the transactions SQL composition is identical to getTransactions
// (shared buildTransactionWhere), the overview aggregations run the SAME shared
// SQL constants + pure math as the server (mirror-overview.ts over
// overview-sql.ts), and the param parsing is identical (shared
// parseTransactionListParams / overview-params.ts). Parity is pinned by
// src/__tests__/mirror-parity.test.ts and overview-parity.test.ts, which
// deep-equal serveApiPath output against the real server functions.
//
// Pure module — no browser glue, no bun:sqlite import.

import {
  composeTransactionListSql,
  type TransactionFilters,
  type TransactionPage,
  type TransactionWhereRules,
} from '../../../../db/transaction-where.js';
import { DASHBOARD_RULES } from '../../../../db/spend-rules.js';
import { parseTransactionListParams } from '../../../../dashboard/transactions-query.js';
import {
  parseAccountId,
  parseEntityId,
  parseDateRange,
  parseSavingsMonths,
  parseBudgetCountdownMonth,
  parseDailySpendingRange,
  parseDashboardOptions,
} from '../../../../dashboard/overview-params.js';
import {
  mirrorGetDailySpending,
  mirrorGetStreak,
  mirrorGetWeeklySummary,
  mirrorGetBudgetCountdown,
  mirrorGetSpendingSummary,
  mirrorGetProfitLoss,
  mirrorGetMonthlySavingsData,
  mirrorGetBudgetVsActualRange,
  mirrorGetCoverage,
  mirrorGetCategoryOptions,
} from './mirror-overview.js';
import {
  parseSpendingBreakdownParams,
  parseSpendingSeriesParams,
  isBadRequest,
} from '../../../../dashboard/spending-params.js';
import { runSpendingBreakdown, runSpendingSeries } from '../../../../db/spending-drill-sql.js';
import type { MirrorEntityRow, MirrorTransactionRow, SqliteBinding, SqlRow } from './types.js';

/**
 * SELECT * on the mirror includes the extra sync_key identity column; served
 * rows must be shape-identical to server JSON, so it is stripped per row.
 */
function stripSyncKey(row: SqlRow): Record<string, unknown> {
  const { sync_key, ...rest } = row;
  void sync_key;
  return rest;
}

/**
 * Mirror counterpart of getTransactions (src/db/queries.ts) — identical SQL
 * composition, identical ordering.
 */
export async function mirrorGetTransactions(
  db: SqliteBinding,
  filters: TransactionFilters = {},
  options: { rules?: TransactionWhereRules; page?: TransactionPage } = {}
): Promise<MirrorTransactionRow[]> {
  const { sql, params } = composeTransactionListSql(filters, options.rules, options.page);
  const rows = await db.prepare(sql).all(params);
  return rows.map(stripSyncKey) as unknown as MirrorTransactionRow[];
}

/**
 * Mirror counterpart of getEntities (src/db/entity-queries.ts) — that module
 * cannot be imported by the UI (its type imports drag bun:sqlite types in), so
 * the SQL is copied verbatim and pinned by the parity test.
 */
export async function mirrorGetEntities(db: SqliteBinding): Promise<MirrorEntityRow[]> {
  const rows = await db
    .prepare('SELECT * FROM entities ORDER BY is_default DESC, name ASC')
    .all();
  return rows as unknown as MirrorEntityRow[];
}

/**
 * Paths that must never come from the mirror. `/api/mcp/*` is live security
 * state (is agent access on, which tools are granted, what is awaiting
 * approval): a stale copy from before the user turned it off would be worse than
 * showing nothing. Offline, these fail with the "requires a connection" state.
 */
export function isMirrorExcluded(path: string): boolean {
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  return pathname.startsWith('/api/mcp/');
}

/**
 * Serve a dashboard API path from the mirror.
 *
 * Routes exactly the paths mirrored so far — the transactions tab's two reads,
 * the eight approved overview cards, /api/coverage, the header's
 * /api/category-options and the spending drill's /api/spending/breakdown +
 * /api/spending/series — replicating the
 * server handlers (including SQL paging, the dashboard spend rules, and the
 * /api/daily-spending `{ error }` shape).
 * Anything else returns null: the caller turns that into an explicit
 * "requires connection" state instead of inventing a response.
 */
export async function serveApiPath(db: SqliteBinding, path: string): Promise<unknown | null> {
  if (isMirrorExcluded(path)) return null;
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const search = queryIndex === -1 ? '' : path.slice(queryIndex + 1);
  const params = new URLSearchParams(search);

  if (pathname === '/api/transactions') {
    const { filters, limit, offset } = parseTransactionListParams(params);
    return mirrorGetTransactions(db, filters, { rules: DASHBOARD_RULES, page: { limit, offset } });
  }
  if (pathname === '/api/coverage') {
    return mirrorGetCoverage(db);
  }
  if (pathname === '/api/entities') {
    return mirrorGetEntities(db);
  }
  if (pathname === '/api/category-options') {
    return mirrorGetCategoryOptions(db);
  }
  // ── Spending drill: the SAME parser + driver as the server handlers. A bad
  // param returns the server's BadRequest object ({ status: 400, error }),
  // which the fetch seam (ui/src/api.ts) raises as the same "API 400" error.
  if (pathname === '/api/spending/breakdown') {
    const query = parseSpendingBreakdownParams(params);
    return isBadRequest(query) ? query : runSpendingBreakdown(db, query);
  }
  if (pathname === '/api/spending/series') {
    const query = parseSpendingSeriesParams(params);
    return isBadRequest(query) ? query : runSpendingSeries(db, query);
  }
  // ── Overview cards (the eight approved offline aggregations) ──────────────
  if (pathname === '/api/daily-spending') {
    const range = parseDailySpendingRange(params);
    if ('error' in range) {
      return range;
    }
    const accountId = parseAccountId(params);
    const entityId = parseEntityId(params);
    return mirrorGetDailySpending(db, range.startDate, range.endDate, accountId, entityId, parseDashboardOptions(params));
  }
  if (pathname === '/api/streak') {
    return mirrorGetStreak(db, undefined, { ...DASHBOARD_RULES, entityId: parseEntityId(params) });
  }
  if (pathname === '/api/weekly-summary') {
    return mirrorGetWeeklySummary(db, undefined, { ...DASHBOARD_RULES, entityId: parseEntityId(params) });
  }
  if (pathname === '/api/budget-countdown') {
    const month = parseBudgetCountdownMonth(params);
    return mirrorGetBudgetCountdown(db, month);
  }
  if (pathname === '/api/summary') {
    const { startDate, endDate } = parseDateRange(params);
    const accountId = parseAccountId(params);
    const entityId = parseEntityId(params);
    return mirrorGetSpendingSummary(db, startDate, endDate, accountId, entityId, parseDashboardOptions(params));
  }
  if (pathname === '/api/pnl') {
    const { startDate, endDate } = parseDateRange(params);
    const accountId = parseAccountId(params);
    const entityId = parseEntityId(params);
    return mirrorGetProfitLoss(db, startDate, endDate, accountId, entityId, parseDashboardOptions(params));
  }
  if (pathname === '/api/savings') {
    const months = parseSavingsMonths(params);
    const accountId = parseAccountId(params);
    const entityId = parseEntityId(params);
    return mirrorGetMonthlySavingsData(db, undefined, months, accountId, entityId, { ...DASHBOARD_RULES });
  }
  if (pathname === '/api/budgets') {
    const { startDate, endDate } = parseDateRange(params);
    const accountId = parseAccountId(params);
    const entityId = parseEntityId(params);
    return mirrorGetBudgetVsActualRange(db, startDate, endDate, accountId, entityId, DASHBOARD_RULES);
  }
  return null;
}