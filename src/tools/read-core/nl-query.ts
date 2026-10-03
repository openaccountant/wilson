// ── read-core: natural-language transaction query parser ─────────────────────
//
// Pure copy of parseNaturalQuery (src/tools/query/transaction-search.ts), with
// `now` and the category names injected instead of read from the clock and the
// database. The behaviour is copied faithfully, quirks included (for example a
// bare year such as "March 2025" also stays in the residual merchant words), so
// the mirror returns exactly what the server tool returns. Parity is pinned by
// mirror-tool-parity.test.ts.
//
// Zero-import apart from the shared filter type.

import type { TransactionFilters } from '../../db/transaction-where.js';

/** Month name -> number mapping */
export const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4,
  may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4,
  jun: 6, jul: 7, aug: 8, sep: 9,
  oct: 10, nov: 11, dec: 12,
};

/**
 * Parse a natural language query into transaction filters.
 *
 * Handles patterns like "dining in January", "Amazon purchases", "over $100",
 * "last month", "this year", specific months.
 */
export function parseNaturalQueryAt(
  query: string,
  now: Date,
  categoryNames: string[]
): TransactionFilters {
  const filters: TransactionFilters = {};
  const lowerQuery = query.toLowerCase();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  // --- Category detection ---
  const matchedCategory = categoryNames.find((cat) =>
    lowerQuery.includes(cat.toLowerCase())
  );
  if (matchedCategory) {
    filters.category = matchedCategory;
  }

  // --- Amount filters ---
  const overMatch = lowerQuery.match(/(?:over|above|more than|greater than|exceeds?)\s*\$?(\d+(?:\.\d{2})?)/);
  if (overMatch) {
    // "over $100" for expenses means amount < -100
    filters.maxAmount = -parseFloat(overMatch[1]);
  }

  const underMatch = lowerQuery.match(/(?:under|below|less than|cheaper than)\s*\$?(\d+(?:\.\d{2})?)/);
  if (underMatch) {
    filters.minAmount = -parseFloat(underMatch[1]);
  }

  // --- Date range: "last month" ---
  if (lowerQuery.includes('last month')) {
    const lastMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const lastMonthYear = currentMonth === 1 ? currentYear - 1 : currentYear;
    filters.dateStart = `${lastMonthYear}-${String(lastMonth).padStart(2, '0')}-01`;
    const lastDay = new Date(lastMonthYear, lastMonth, 0).getDate();
    filters.dateEnd = `${lastMonthYear}-${String(lastMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  }

  // --- Date range: "this month" ---
  if (lowerQuery.includes('this month')) {
    filters.dateStart = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;
    const lastDay = new Date(currentYear, currentMonth, 0).getDate();
    filters.dateEnd = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  }

  // --- Date range: "this year" ---
  if (lowerQuery.includes('this year')) {
    filters.dateStart = `${currentYear}-01-01`;
    filters.dateEnd = `${currentYear}-12-31`;
  }

  // --- Date range: "last year" ---
  if (lowerQuery.includes('last year')) {
    filters.dateStart = `${currentYear - 1}-01-01`;
    filters.dateEnd = `${currentYear - 1}-12-31`;
  }

  // --- Date range: specific month name (e.g., "in January", "January 2025") ---
  if (!filters.dateStart) {
    for (const [monthName, monthNum] of Object.entries(MONTH_NAMES)) {
      const monthPattern = new RegExp(`\\b${monthName}\\b`, 'i');
      if (monthPattern.test(query)) {
        // Check for year after month name
        const yearMatch = query.match(new RegExp(`${monthName}\\s*(\\d{4})`, 'i'));
        const year = yearMatch ? parseInt(yearMatch[1]) : currentYear;
        filters.dateStart = `${year}-${String(monthNum).padStart(2, '0')}-01`;
        const lastDay = new Date(year, monthNum, 0).getDate();
        filters.dateEnd = `${year}-${String(monthNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        break;
      }
    }
  }

  // --- Merchant/description search ---
  // Extract potential merchant names: words that are not category names, date words, or filter words
  const stopWords = new Set([
    'in', 'on', 'at', 'for', 'from', 'to', 'the', 'a', 'an', 'and', 'or',
    'my', 'all', 'show', 'find', 'get', 'list', 'search', 'transactions',
    'purchases', 'spending', 'charges', 'payments', 'expenses', 'expense',
    'over', 'under', 'above', 'below', 'more', 'less', 'than', 'greater',
    'last', 'this', 'next', 'month', 'year', 'week', 'today', 'yesterday',
    'recurring', ...Object.keys(MONTH_NAMES),
    ...categoryNames.map((c) => c.toLowerCase()),
  ]);

  // Remove dollar amounts and filter words, look for remaining significant words
  const cleaned = query
    .replace(/\$\d+(?:\.\d{2})?/g, '')
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w.toLowerCase()));

  if (cleaned.length > 0 && !filters.category) {
    // Use the remaining words as a merchant search
    filters.merchant = cleaned.join(' ');
  }

  // --- Recurring filter ---
  if (lowerQuery.includes('recurring') || lowerQuery.includes('subscription')) {
    filters.isRecurring = true;
  }

  return filters;
}
