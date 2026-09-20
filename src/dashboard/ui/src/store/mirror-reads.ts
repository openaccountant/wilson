// ── Offline mirror: read layer ───────────────────────────────────────────────
//
// Serves the two endpoints the transactions tab reads, with byte-parity to the
// server: the SQL composition is identical to getTransactions (shared
// buildTransactionWhere) and the param parsing is identical to apiTransactions
// (shared parseTransactionListParams). The parity is pinned by
// src/__tests__/mirror-parity.test.ts, which deep-equals serveApiPath output
// against the real server functions for a matrix of queries.
//
// Pure module — no browser glue, no bun:sqlite import.

import { buildTransactionWhere, type TransactionFilters } from '../../../../db/transaction-where.js';
import { parseTransactionListParams } from '../../../../dashboard/transactions-query.js';
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
 * Routes exactly the paths this slice mirrors — `/api/transactions?…` and
 * `/api/entities` — replicating the server handlers (including the
 * slice-to-limit, NaN limit included). Anything else returns null: the caller
 * keeps the original network error instead of inventing a response.
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
  return null;
}