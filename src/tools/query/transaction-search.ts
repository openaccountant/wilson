import { z } from 'zod';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { getTransactions, getCategories, type TransactionFilters, type TransactionRow } from '../../db/queries.js';
import { CATEGORIES } from '../categorize/categories.js';
import { formatToolResult } from '../types.js';

// Module-level database reference
let db: Database | null = null;

/**
 * Initialize the transaction_search tool with a database connection.
 * Must be called before the agent starts.
 */
export function initTransactionSearchTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) {
    throw new Error(
      'transaction_search tool not initialized. Call initTransactionSearchTool(database) first.'
    );
  }
  return db;
}

/** Month name -> number mapping */
const MONTH_NAMES: Record<string, number> = {
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
 * Handles patterns like:
 * - "dining in January" -> category + date filter
 * - "Amazon purchases" -> description LIKE '%Amazon%'
 * - "over $100" / "more than $50" -> amount filter
 * - "last month", "this year", specific months
 */
/**
 * Get category names from DB with fallback to hardcoded list.
 */
function getCategoryNames(): string[] {
  if (!db) return CATEGORIES;
  try {
    const rows = getCategories(db);
    if (rows.length > 0) return rows.map(r => r.name);
  } catch {
    // categories table may not exist
  }
  return CATEGORIES;
}

function parseNaturalQuery(query: string): TransactionFilters {
  const filters: TransactionFilters = {};
  const lowerQuery = query.toLowerCase();
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  // --- Category detection ---
  const categoryNames = getCategoryNames();
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

/**
 * Format transaction rows for display.
 */
function formatResults(transactions: TransactionRow[]): string {
  if (transactions.length === 0) {
    return 'No transactions found matching your query.';
  }

  const lines = transactions.slice(0, 100).map((t) => {
    const cat = t.category ?? 'Uncategorized';
    const amt = t.amount < 0 ? `-$${Math.abs(t.amount).toFixed(2)}` : `+$${t.amount.toFixed(2)}`;
    return `${t.date}  ${amt.padStart(10)}  ${cat.padEnd(16)}  ${t.description}`;
  });

  const total = transactions.reduce((sum, t) => sum + t.amount, 0);
  const totalFormatted = total < 0 ? `-$${Math.abs(total).toFixed(2)}` : `+$${total.toFixed(2)}`;

  return [
    `Found ${transactions.length} transaction${transactions.length === 1 ? '' : 's'}:`,
    '',
    'Date        Amount      Category          Description',
    '----------  ----------  ----------------  -----------',
    ...lines,
    '',
    `Total: ${totalFormatted}`,
    transactions.length > 100 ? `\n(Showing first 100 of ${transactions.length})` : '',
  ].join('\n');
}

/**
 * Transaction search tool — translates natural language queries into database filters.
 */
export const transactionSearchTool = defineTool({
  name: 'transaction_search',
  description:
    'Search transactions using natural language. Examples: "dining in January", ' +
    '"Amazon purchases", "over $100", "recurring charges last month".',
  schema: z.object({
    query: z.string().describe('Natural language query about transactions'),
  }),
  func: async ({ query }) => {
    const database = getDb();
    const filters = parseNaturalQuery(query);
    const transactions = getTransactions(database, filters);
    const formatted = formatResults(transactions);

    return formatToolResult({
      query,
      filtersApplied: filters,
      count: transactions.length,
      formatted,
      transactions: transactions.slice(0, 100).map((t) => ({
        id: t.id,
        date: t.date,
        description: t.description,
        amount: t.amount,
        category: t.category,
      })),
    });
  },
});
