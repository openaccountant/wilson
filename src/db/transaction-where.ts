// ── Shared transaction WHERE builder ──────────────────────────────────────────
//
// Zero-import module: it must stay safe to pull into both the server bundle and
// the dashboard UI bundle (the UI tsconfig must not transitively reach any
// `bun:sqlite`-importing module). `getTransactions` (src/db/queries.ts) and the
// offline mirror's read layer (src/dashboard/ui/src/store/mirror-reads.ts) both
// compose their SQL from this one builder so server and mirror results stay
// identical for the same filters — drift fails the mirror parity test in CI.

export interface TransactionFilters {
  dateStart?: string;
  dateEnd?: string;
  category?: string;
  minAmount?: number;
  maxAmount?: number;
  merchant?: string;
  isRecurring?: boolean;
  accountId?: number;
  entityId?: number;
}

/**
 * Build the AND-composed WHERE clause (plus named params) for the
 * transactions table. Returns an empty `whereSql` when no filters are set.
 */
export function buildTransactionWhere(
  filters: TransactionFilters
): { whereSql: string; params: Record<string, unknown> } {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters.dateStart) {
    conditions.push('date >= @dateStart');
    params.dateStart = filters.dateStart;
  }
  if (filters.dateEnd) {
    conditions.push('date <= @dateEnd');
    params.dateEnd = filters.dateEnd;
  }
  if (filters.category) {
    conditions.push('category = @category');
    params.category = filters.category;
  }
  if (filters.minAmount !== undefined) {
    conditions.push('amount >= @minAmount');
    params.minAmount = filters.minAmount;
  }
  if (filters.maxAmount !== undefined) {
    conditions.push('amount <= @maxAmount');
    params.maxAmount = filters.maxAmount;
  }
  if (filters.merchant) {
    conditions.push('description LIKE @merchant');
    params.merchant = `%${filters.merchant}%`;
  }
  if (filters.isRecurring !== undefined) {
    conditions.push('is_recurring = @isRecurring');
    params.isRecurring = filters.isRecurring ? 1 : 0;
  }
  if (filters.accountId !== undefined) {
    conditions.push('account_id = @accountId');
    params.accountId = filters.accountId;
  }
  if (filters.entityId !== undefined) {
    conditions.push('entity_id = @entityId');
    params.entityId = filters.entityId;
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { whereSql, params };
}