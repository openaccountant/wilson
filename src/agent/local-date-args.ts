/**
 * Date arguments for local (Transformers.js) model tool calls.
 *
 * spending_summary only knows the CURRENT month, quarter or year, and small
 * local models call it that way even when the user named another month
 * (granite, asked about "August 2026" in October, called
 * {period: 'month'} and answered with October's numbers). Instead of hoping
 * the model maps dates, the agent fills the named month into the call. It also
 * works around transaction_search's year-as-merchant quirk (see below).
 */

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const MONTH_RE = new RegExp(`\\b(${MONTHS.join('|')})\\b(?:,?\\s*(\\d{4})\\b)?`, 'gi');

/**
 * The single month the query names, as "YYYY-MM", or null when it names none
 * or several. A month without a year is the most recent one not in the future.
 * "may" counts only with a year or after in/for/during/of/since ("May I…").
 */
export function namedMonth(query: string, now: Date = new Date()): string | null {
  const found = new Set<string>();
  const bare = new Set<number>();
  for (const m of query.matchAll(MONTH_RE)) {
    const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    if (month === 5 && !m[2] && !/\b(?:in|for|during|of|since)\s+$/i.test(query.slice(0, m.index))) continue;
    if (m[2]) {
      found.add(`${m[2]}-${String(month).padStart(2, '0')}`);
    } else {
      bare.add(month);
    }
  }
  for (const month of bare) {
    // "August vs August 2026": the bare mention is the same month.
    if ([...found].some((f) => Number(f.slice(5)) === month)) continue;
    const year = month > now.getMonth() + 1 ? now.getFullYear() - 1 : now.getFullYear();
    found.add(`${year}-${String(month).padStart(2, '0')}`);
  }
  return found.size === 1 ? [...found][0] : null;
}

/** A month (as transaction_search's parser spells them) followed by a year. */
const SEARCH_MONTH_YEAR_RE = new RegExp(
  `\\b(${MONTHS.join('|')}|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec),?\\s*(\\d{4})\\b`,
  'gi',
);

/**
 * The call's arguments with the query's named month filled in, or the same
 * object when there is nothing to change:
 * - spending_summary for the current month (or with no period) while the
 *   user asked about another month gets that month;
 * - transaction_search drops a current-year year after a month name: its
 *   parser keeps the year in the merchant words ("August 2026 expenses" ->
 *   merchant "2026", no rows) and defaults to the current year anyway.
 */
export function resolveLocalDateArgs(
  query: string,
  tool: string,
  args: Record<string, unknown>,
  now: Date = new Date(),
): Record<string, unknown> {
  if (tool === 'transaction_search' && typeof args.query === 'string') {
    const year = String(now.getFullYear());
    const stripped = args.query.replace(SEARCH_MONTH_YEAR_RE, (all, month: string, y: string) => (y === year ? month : all));
    return stripped === args.query ? args : { ...args, query: stripped };
  }
  if (tool !== 'spending_summary') return args;
  if (args.month !== undefined || (args.period !== undefined && args.period !== 'month')) return args;
  const month = namedMonth(query, now);
  const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (!month || month === current) return args;
  return { ...args, period: 'month', month };
}
