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

import { buildTransactionWhere, type TransactionFilters } from '../../../../db/transaction-where.js';
import { parseTransactionListParams } from '../../../../dashboard/transactions-query.js';
import {
  parseAccountId,
  parseEntityId,
  parseDateRange,
  parseSavingsMonths,
  parseBudgetCountdownMonth,
  parseDailySpendingRange,
} from '../../../../dashboard/overview-params.js';
import {
  mirrorGetDailySpending,
  mirrorGetStreak,
  mirrorGetWeeklySummary,
  mirrorGetBudgetCountdown,
  mirrorGetSpendingSummary,
  mirrorGetProfitLoss,
  mirrorGetMonthlySavingsData,
  mirrorGetBudgetVsActual,
} from './mirror-overview.js';
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
  filters: TransactionFilters = {}
): Promise<MirrorTransactionRow[]> {
  const { whereSql, params } = buildTransactionWhere(filters);
  const rows = await db
    .prepare(`SELECT * FROM transactions ${whereSql} ORDER BY date DESC`)
    .all(params);
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
 * Serve a dashboard API path from the mirror.
 *
 * Routes exactly the paths mirrored so far — the transactions tab's two reads
 * plus the eight approved overview cards — replicating the server handlers
 * (including the slice-to-limit and the /api/daily-spending `{ error }` shape).
 * Anything else returns null: the caller turns that into an explicit
 * "requires connection" state instead of inventing a response.
 */
export async function serveApiPath(db: SqliteBinding, path: string): Promise<unknown | null> {
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const search = queryIndex === -1 ? '' : path.slice(queryIndex + 1);
  const params = new URLSearchParams(search);

  if (pathname === '/api/transactions') {
    const { filters, limit } = parseTransactionListParams(params);
    const rows = await mirrorGetTransactions(db, filters);
    return rows.slice(0, limit);
  }
  if (pathname === '/api/entities') {
    return mirrorGetEntities(db);
  }
  // ── Overview cards (the eight approved offline aggregations) ──────────────
  if (pathname === '/api/daily-spending') {
    const range = parseDailySpendingRange(params);
    if ('error' in range) {
      return range;
    }
    return mirrorGetDailySpending(db, range.startDate, range.endDate);
  }
  if (pathname === '/api/streak') {
    return mirrorGetStreak(db);
  }
  if (pathname === '/api/weekly-summary') {
    return mirrorGetWeeklySummary(db);
  }
  if (pathname === '/api/budget-countdown') {
    const month = parseBudgetCountdownMonth(params);
    return mirrorGetBudgetCountdown(db, month);
  }
  if (pathname === '/api/summary') {
    const { startDate, endDate } = parseDateRange(params);
    const accountId = parseAccountId(params);
    const entityId = parseEntityId(params);
    return mirrorGetSpendingSummary(db, startDate, endDate, accountId, entityId);
  }
  if (pathname === '/api/pnl') {
    const { startDate, endDate } = parseDateRange(params);
    const accountId = parseAccountId(params);
    const entityId = parseEntityId(params);
    return mirrorGetProfitLoss(db, startDate, endDate, accountId, entityId);
  }
  if (pathname === '/api/savings') {
    const months = parseSavingsMonths(params);
    const accountId = parseAccountId(params);
    const entityId = parseEntityId(params);
    return mirrorGetMonthlySavingsData(db, undefined, months, accountId, entityId);
  }
  if (pathname === '/api/budgets') {
    const { month } = parseDateRange(params);
    const accountId = parseAccountId(params);
    const entityId = parseEntityId(params);
    return mirrorGetBudgetVsActual(db, month, accountId, entityId);
  }
  return null;
}