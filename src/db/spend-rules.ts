// ── Dashboard spend / income classification rules ────────────────────────────
//
// The single source for how the DASHBOARD classifies a transaction as spending
// or income. These rules are OPT-IN: the shared composers (overview-sql.ts,
// transaction-where.ts) only apply them when a caller passes the dashboard
// flags, and only the dashboard endpoints (src/dashboard/api.ts) and the
// offline mirror (src/dashboard/ui/src/store/*) do. CLI tools, reports, goals
// and context hints keep their historical `amount < 0` / `amount > 0 OR
// category = 'Income'` semantics byte-for-byte (pinned by
// src/__tests__/spend-rules.test.ts).
//
// Rules:
//   - NON-SPEND: rows whose category is a transfer/payment/income label never
//     count as spending, whatever their sign (a credit-card payment out of
//     checking is not an expense — the card purchases already were).
//   - SPEND: amount < 0 AND category not in NON_SPEND_CATEGORIES.
//   - INCOME: category = 'Income' regardless of sign (some importers store
//     paychecks as negative amounts), OR amount > 0 AND category not
//     non-spend. Income is summed as ABS(amount) so a negative-stored paycheck
//     still adds to income.
//   - UNCATEGORIZED: NULL, blank, or the literal 'Uncategorized' label are one
//     bucket, labelled 'Uncategorized'.
//
// The category list is the transfer/payment vocabulary that actually reaches
// the transactions table: 'Income' and 'Transfer' from the categorizer
// (src/tools/categorize/categories.ts), and Plaid's legacy leaf categories
// ('Internal Account Transfer', 'Credit Card', 'Payment') written by
// plaid-sync (txn.category's last element), plus 'Credit Card Payment' from
// CSV exports. Investment-sweep labels are deliberately NOT included: they are
// not clearly transfers between the user's own spending accounts.
//
// ZERO imports: must stay safe for the dashboard UI bundle (same constraint as
// transaction-where.ts / overview-sql.ts).

export const UNCATEGORIZED_LABEL = 'Uncategorized';

export const INCOME_CATEGORY = 'Income';

/** Categories that are never spending (transfers, card payments, income). */
export const NON_SPEND_CATEGORIES: readonly string[] = Object.freeze([
  'Income',
  'Transfer',
  'Internal Account Transfer',
  'Credit Card',
  'Credit Card Payment',
  'Payment',
]);

const NON_SPEND_SET = new Set(NON_SPEND_CATEGORIES);

// ── Pure predicates (JS side; same semantics as the SQL fragments) ──────────

export interface ClassifiableRow {
  amount: number;
  category?: string | null;
}

export function isNonSpendCategory(category: string | null | undefined): boolean {
  return category != null && NON_SPEND_SET.has(category);
}

export function isUncategorized(category: string | null | undefined): boolean {
  return category == null || category.trim() === '' || category === UNCATEGORIZED_LABEL;
}

/** Display label: blank/NULL/'Uncategorized' → 'Uncategorized'. */
export function categoryLabel(category: string | null | undefined): string {
  return isUncategorized(category) ? UNCATEGORIZED_LABEL : (category as string).trim();
}

export function isSpend(row: ClassifiableRow): boolean {
  return row.amount < 0 && !isNonSpendCategory(row.category);
}

export function isIncome(row: ClassifiableRow): boolean {
  if (row.category === INCOME_CATEGORY) return true;
  return row.amount > 0 && !isNonSpendCategory(row.category);
}

/** Income contribution of a row (0 when it is not income). */
export function incomeAmount(row: ClassifiableRow): number {
  return isIncome(row) ? Math.abs(row.amount) : 0;
}

// ── SQL fragment builders (shared by server SQL and mirror SQL) ─────────────

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** `'Income', 'Transfer', …` — the NON_SPEND_CATEGORIES list as SQL literals. */
export const NON_SPEND_SQL_LIST = NON_SPEND_CATEGORIES.map(quote).join(', ');

function col(alias: string | undefined, name: string): string {
  return alias ? `${alias}.${name}` : name;
}

/** COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized') — the grouping label. */
export function categoryLabelSql(alias?: string): string {
  return `COALESCE(NULLIF(TRIM(${col(alias, 'category')}), ''), ${quote(UNCATEGORIZED_LABEL)})`;
}

/** True when the row's category is NULL, blank, or 'Uncategorized'. */
export function uncategorizedSql(alias?: string): string {
  const c = col(alias, 'category');
  return `(${c} IS NULL OR TRIM(${c}) = '' OR ${c} = ${quote(UNCATEGORIZED_LABEL)})`;
}

/** True when the row's category is a non-spend label. */
export function nonSpendSql(alias?: string): string {
  return `COALESCE(${col(alias, 'category')}, '') IN (${NON_SPEND_SQL_LIST})`;
}

/** SPEND: amount < 0 AND category not non-spend. */
export function spendSql(alias?: string): string {
  return `(${col(alias, 'amount')} < 0 AND COALESCE(${col(alias, 'category')}, '') NOT IN (${NON_SPEND_SQL_LIST}))`;
}

/** INCOME: category 'Income' (any sign) OR amount > 0 and not non-spend. */
export function incomeSql(alias?: string): string {
  const c = col(alias, 'category');
  const a = col(alias, 'amount');
  return `(${c} = ${quote(INCOME_CATEGORY)} OR (${a} > 0 AND COALESCE(${c}, '') NOT IN (${NON_SPEND_SQL_LIST})))`;
}

/** The income amount expression: ABS(amount) (only meaningful under incomeSql). */
export function incomeAmountSql(alias?: string): string {
  return `ABS(${col(alias, 'amount')})`;
}

/**
 * Exact category filter on the dashboard's grouping LABEL
 * (categoryLabelSql: TRIM'd, NULL/blank → 'Uncategorized'), so a filter value
 * taken from a grouped row matches exactly the rows that row summed — ' Dining '
 * is in the 'Dining' bucket and the 'Dining' filter alike. 'Uncategorized'
 * therefore matches NULL / blank / 'Uncategorized' rows. Dashboard rules only
 * (uncategorizedMatchesBlank); the CLI keeps `category = @category`.
 */
export function categoryFilterSql(
  category: string,
  alias?: string,
  param: string = 'category'
): { sql: string; params: Record<string, unknown> } {
  return { sql: `${categoryLabelSql(alias)} = @${param}`, params: { [param]: category } };
}

/**
 * Entity filter whose default entity also owns un-assigned rows: rows with
 * entity_id IS NULL belong to the default entity (entities.is_default = 1).
 */
export function entityFilterSql(
  entityId: number,
  alias?: string,
  param: string = 'entityId'
): { sql: string; params: Record<string, unknown> } {
  const e = col(alias, 'entity_id');
  return {
    sql: `(${e} = @${param} OR (${e} IS NULL AND @${param} IN (SELECT id FROM entities WHERE is_default = 1)))`,
    params: { [param]: entityId },
  };
}

/**
 * Merchant exact match: the same label the merchant typeahead groups by
 * (merchant_name when non-blank, else description).
 */
export function merchantLabelSql(alias?: string): string {
  return `COALESCE(NULLIF(TRIM(${col(alias, 'merchant_name')}), ''), ${col(alias, 'description')})`;
}

// ── The dashboard rule set ───────────────────────────────────────────────────

/**
 * Opt-in flags for the shared composers. Every flag defaults OFF so a caller
 * that passes nothing gets the historical SQL byte-for-byte.
 */
export interface DashboardRules {
  /** Spending aggregates exclude NON_SPEND_CATEGORIES (not just amount < 0). */
  excludeNonSpend?: boolean;
  /** Income = INCOME rule, summed as ABS(amount). */
  normalizedIncome?: boolean;
  /** Group/label by categoryLabelSql (one Uncategorized bucket). */
  labelGrouping?: boolean;
  /** A category filter of 'Uncategorized' matches NULL/blank rows too. */
  uncategorizedMatchesBlank?: boolean;
  /** The default entity's filter also matches entity_id IS NULL rows. */
  defaultEntityIncludesNull?: boolean;
}

/** Every dashboard rule on — what src/dashboard/api.ts and the mirror pass. */
export const DASHBOARD_RULES: Readonly<Required<DashboardRules>> = Object.freeze({
  excludeNonSpend: true,
  normalizedIncome: true,
  labelGrouping: true,
  uncategorizedMatchesBlank: true,
  defaultEntityIncludesNull: true,
});

/** True when any rule is on (a composer then takes its dashboard branch). */
export function hasDashboardRules(rules: DashboardRules | undefined): boolean {
  if (!rules) return false;
  return Boolean(
    rules.excludeNonSpend ||
      rules.normalizedIncome ||
      rules.labelGrouping ||
      rules.uncategorizedMatchesBlank ||
      rules.defaultEntityIncludesNull
  );
}

// ── Month arithmetic for range-mode budgets ─────────────────────────────────

const DAY_MS = 86_400_000;

function utcDay(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  // Reject impossible dates (2026-02-30) rather than rolling them over.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t;
}

/**
 * Budget months in an inclusive [startDate, endDate] range, PRORATED by day:
 * each calendar month contributes (days of the range inside it) / (days in
 * that month). A whole month → 1, Jan 1–Mar 31 → 3, a 2-day range across a
 * month boundary (Jan 31–Feb 1) → 1/31 + 1/28, YTD through Oct 2 → 9 + 2/31.
 * A range-mode budget limit is monthly_limit × this value.
 *
 * Malformed or inverted ranges count as one month (the historical fallback).
 */
export function monthsInRange(startDate: string, endDate: string): number {
  const start = utcDay(startDate);
  const end = utcDay(endDate);
  if (start === null || end === null || end < start) return 1;
  let months = 0;
  let cursor = start;
  while (cursor <= end) {
    const d = new Date(cursor);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const monthEnd = Date.UTC(y, m + 1, 0); // last day of this month
    const daysInMonth = new Date(monthEnd).getUTCDate();
    const sliceEnd = Math.min(end, monthEnd);
    const days = Math.round((sliceEnd - cursor) / DAY_MS) + 1;
    // A whole month adds exactly 1 (no float drift on multi-month ranges).
    months += days === daysInMonth ? 1 : days / daysInMonth;
    cursor = monthEnd + DAY_MS;
  }
  return months;
}
