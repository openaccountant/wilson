// ── Shared /api/transactions query-param parsing ─────────────────────────────
//
// Extracted verbatim from apiTransactions (src/dashboard/api.ts) so the server
// endpoint and the offline mirror's `serveApiPath` parse the exact same query
// params — including the edge behaviors, e.g. `limit=` (empty string) parses to
// NaN, which slices the list to zero on both sides. Parity means replicating
// this behavior, not fixing it.
//
// Import-safe for the dashboard UI bundle: the only import is a type from the
// zero-import transaction-where module.

import type { TransactionFilters } from '../db/transaction-where.js';

export interface TransactionListParams {
  filters: TransactionFilters;
  limit: number;
}

export function parseTransactionListParams(params: URLSearchParams): TransactionListParams {
  const filters: TransactionFilters = {};
  const start = params.get('start');
  const end = params.get('end');
  const category = params.get('category');
  const merchant = params.get('merchant');
  const accountIdVal = params.get('accountId');
  const entityIdVal = params.get('entityId');
  const accountId = accountIdVal ? parseInt(accountIdVal, 10) : undefined;
  const entityId = entityIdVal ? parseInt(entityIdVal, 10) : undefined;
  if (start) filters.dateStart = start;
  if (end) filters.dateEnd = end;
  if (category) filters.category = category;
  if (merchant) filters.merchant = merchant;
  if (accountId !== undefined) filters.accountId = accountId;
  if (entityId !== undefined) filters.entityId = entityId;
  const limit = parseInt(params.get('limit') ?? '100', 10);
  return { filters, limit };
}