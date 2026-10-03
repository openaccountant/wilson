// ── Shared transaction WHERE builder ──────────────────────────────────────────
//
// Import-safe for both the server bundle and the dashboard UI bundle (the UI
// tsconfig must not transitively reach any `bun:sqlite`-importing module); its
// only import is the zero-import spend-rules module. `getTransactions`
// (src/db/queries.ts) and the offline mirror's read layer
// (src/dashboard/ui/src/store/mirror-reads.ts) both compose their SQL from this
// one builder so server and mirror results stay identical for the same filters
// — drift fails the mirror parity test in CI.

import {
  categoryFilterSql,
  entityFilterSql,
  merchantLabelSql,
  spendSql,
  type DashboardRules,
} from './spend-rules.js';

export interface TransactionFilters {
  dateStart?: string;
  dateEnd?: string;
  category?: string;
  minAmount?: number;
  maxAmount?: number;
  /** Fuzzy: description LIKE %merchant% (historical semantics, unchanged). */
  merchant?: string;
  /** Exact: COALESCE(NULLIF(TRIM(merchant_name), ''), description) = value. */
  merchantExact?: string;
  isRecurring?: boolean;
  accountId?: number;
  entityId?: number;
  /** Only SPEND rows (amount < 0 and not a transfer/payment/income label). */
  spendOnly?: boolean;
}

/** Rules this builder honors (see spend-rules.ts); all default OFF. */
export type TransactionWhereRules = Pick<DashboardRules, 'uncategorizedMatchesBlank' | 'defaultEntityIncludesNull'>;

/**
 * Build the AND-composed WHERE condition list (plus named params) for the
 * transactions table, optionally alias-qualified. Without `rules`, the
 * conditions are exactly the historical ones.
 */
export function buildTransactionConditions(
  filters: TransactionFilters,
  rules: TransactionWhereRules = {},
  alias?: string
): { conditions: string[]; params: Record<string, unknown> } {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  const c = (name: string) => (alias ? `${alias}.${name}` : name);

  if (filters.dateStart) {
    conditions.push(`${c('date')} >= @dateStart`);
    params.dateStart = filters.dateStart;
  }
  if (filters.dateEnd) {
    conditions.push(`${c('date')} <= @dateEnd`);
    params.dateEnd = filters.dateEnd;
  }
  if (filters.category) {
    if (rules.uncategorizedMatchesBlank) {
      const f = categoryFilterSql(filters.category, alias);
      conditions.push(f.sql);
      Object.assign(params, f.params);
    } else {
      conditions.push(`${c('category')} = @category`);
      params.category = filters.category;
    }
  }
  if (filters.minAmount !== undefined) {
    conditions.push(`${c('amount')} >= @minAmount`);
    params.minAmount = filters.minAmount;
  }
  if (filters.maxAmount !== undefined) {
    conditions.push(`${c('amount')} <= @maxAmount`);
    params.maxAmount = filters.maxAmount;
  }
  if (filters.merchant) {
    conditions.push(`${c('description')} LIKE @merchant`);
    params.merchant = `%${filters.merchant}%`;
  }
  if (filters.merchantExact) {
    conditions.push(`${merchantLabelSql(alias)} = @merchantExact`);
    params.merchantExact = filters.merchantExact;
  }
  if (filters.isRecurring !== undefined) {
    conditions.push(`${c('is_recurring')} = @isRecurring`);
    params.isRecurring = filters.isRecurring ? 1 : 0;
  }
  if (filters.accountId !== undefined) {
    conditions.push(`${c('account_id')} = @accountId`);
    params.accountId = filters.accountId;
  }
  if (filters.entityId !== undefined) {
    if (rules.defaultEntityIncludesNull) {
      const f = entityFilterSql(filters.entityId, alias);
      conditions.push(f.sql);
      Object.assign(params, f.params);
    } else {
      conditions.push(`${c('entity_id')} = @entityId`);
      params.entityId = filters.entityId;
    }
  }
  if (filters.spendOnly) {
    conditions.push(spendSql(alias));
  }

  return { conditions, params };
}

/**
 * Build the AND-composed WHERE clause (plus named params) for the
 * transactions table. Returns an empty `whereSql` when no filters are set.
 */
export function buildTransactionWhere(
  filters: TransactionFilters,
  rules: TransactionWhereRules = {}
): { whereSql: string; params: Record<string, unknown> } {
  const { conditions, params } = buildTransactionConditions(filters, rules);
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { whereSql, params };
}

export interface TransactionPage {
  limit?: number;
  offset?: number;
}

/**
 * The full transaction-list SELECT (getTransactions and the mirror). Paging,
 * when given, runs in SQL (LIMIT/OFFSET) instead of slicing in JS. `id DESC`
 * breaks same-date ties so pages are stable.
 */
export function composeTransactionListSql(
  filters: TransactionFilters,
  rules: TransactionWhereRules = {},
  page?: TransactionPage
): { sql: string; params: Record<string, unknown> } {
  const { whereSql, params } = buildTransactionWhere(filters, rules);
  if (!page || (page.limit === undefined && page.offset === undefined)) {
    return { sql: `SELECT * FROM transactions ${whereSql} ORDER BY date DESC`, params };
  }
  // SQLite: LIMIT -1 = unbounded (needed when only an offset is given). A
  // non-finite or negative limit yields no rows (the historical `limit=`
  // → NaN → slice(0, NaN) → [] behavior); a bad offset starts at 0.
  const limit = page.limit === undefined
    ? -1
    : Number.isFinite(page.limit) ? Math.max(0, Math.trunc(page.limit)) : 0;
  const offset = Number.isFinite(page.offset) ? Math.max(0, Math.trunc(page.offset as number)) : 0;
  return {
    sql: `SELECT * FROM transactions ${whereSql} ORDER BY date DESC, id DESC LIMIT @limit OFFSET @offset`,
    params: { ...params, limit, offset },
  };
}
