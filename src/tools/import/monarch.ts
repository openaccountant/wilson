import { z } from 'zod';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { insertTransactions, recordImport, type TransactionInsert } from '../../db/queries.js';
import { formatToolResult } from '../types.js';
import { hasLicense } from '../../licensing/license.js';

// Module-level database reference
let db: Database | null = null;

/**
 * Initialize the monarch_import tool with a database connection.
 * Must be called before the agent starts.
 */
export function initMonarchTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) {
    throw new Error('monarch_import tool not initialized. Call initMonarchTool(database) first.');
  }
  return db;
}

/** Shape of a transaction returned by Monarch's GraphQL API. */
interface MonarchTransaction {
  id: string;
  amount: number;
  date: string;
  pending: boolean;
  plaidName: string | null;
  notes: string | null;
  isRecurring: boolean;
  category: { name: string } | null;
  merchant: { name: string } | null;
  account: { displayName: string } | null;
}

/**
 * Monarch Money import tool — authenticates with the Monarch API,
 * fetches transactions, maps to OA's schema, and bulk-inserts.
 * Deduplicates by checking for existing monarch transactions with same date/amount/description.
 */
export const monarchImportTool = defineTool({
  name: 'monarch_import',
  description:
    'Import transactions from Monarch Money. Requires MONARCH_TOKEN env var (or MONARCH_EMAIL + MONARCH_PASSWORD). ' +
    'Fetches transactions via Monarch API and imports them into the local database.',
  schema: z.object({
    limit: z
      .number()
      .optional()
      .describe('Max transactions to fetch (default: 500)'),
    startDate: z
      .string()
      .optional()
      .describe('Start date filter (YYYY-MM-DD)'),
    endDate: z
      .string()
      .optional()
      .describe('End date filter (YYYY-MM-DD)'),
  }),
  func: async ({ limit = 500, startDate, endDate }) => {
    // Pro license gate
    if (!hasLicense('pro')) {
      return formatToolResult({
        error: 'Monarch import is a Pro feature. Run `/license` for details or visit openaccountant.ai/pricing.',
      });
    }

    const database = getDb();

    // 1. Authenticate with Monarch
    try {
      const { setToken } = await import('monarch-money-api');

      const token = process.env.MONARCH_TOKEN;
      if (token) {
        setToken(token);
      } else if (process.env.MONARCH_EMAIL && process.env.MONARCH_PASSWORD) {
        const { loginUser } = await import('monarch-money-api');
        await loginUser(process.env.MONARCH_EMAIL, process.env.MONARCH_PASSWORD);
      } else {
        return formatToolResult({
          error:
            'Monarch Money credentials not configured. Set MONARCH_TOKEN, or both MONARCH_EMAIL and MONARCH_PASSWORD in your environment.',
        });
      }
    } catch (err) {
      return formatToolResult({
        error: `Monarch authentication failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // 2. Fetch transactions
    let rawTransactions: MonarchTransaction[];
    try {
      const { getTransactions } = await import('monarch-money-api');
      const fetchOpts: Record<string, unknown> = { limit };
      if (startDate && endDate) {
        fetchOpts.startDate = startDate;
        fetchOpts.endDate = endDate;
      }
      const result = await getTransactions(fetchOpts);
      rawTransactions = (result?.allTransactions?.results ?? []) as MonarchTransaction[];
    } catch (err) {
      return formatToolResult({
        error: `Failed to fetch Monarch transactions: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (rawTransactions.length === 0) {
      return formatToolResult({
        transactionsImported: 0,
        message: 'No transactions found in Monarch Money for the given filters.',
      });
    }

    // 3. Build a set of existing monarch transactions for dedup
    const existing = new Set<string>();
    const existingRows = database
      .prepare(
        `SELECT date, description, amount FROM transactions WHERE bank = 'monarch'`,
      )
      .all() as { date: string; description: string; amount: number }[];
    for (const row of existingRows) {
      existing.add(`${row.date}|${row.description}|${row.amount}`);
    }

    // 4. Map to OA's schema and deduplicate
    const txns: TransactionInsert[] = [];
    let skipped = 0;
    for (const t of rawTransactions) {
      if (t.pending) {
        skipped++;
        continue;
      }

      const description = t.merchant?.name || t.plaidName || 'Unknown';
      const date = t.date; // Already YYYY-MM-DD from Monarch
      // Monarch uses positive = expense, negative = income. OA uses negative = expense.
      const amount = -t.amount;

      const key = `${date}|${description}|${amount}`;
      if (existing.has(key)) {
        skipped++;
        continue;
      }

      txns.push({
        date,
        description,
        amount,
        category: t.category?.name ?? undefined,
        bank: 'monarch',
        source_file: 'monarch-sync',
        is_recurring: t.isRecurring ? 1 : 0,
        notes: t.notes ?? undefined,
      });
    }

    if (txns.length === 0) {
      return formatToolResult({
        transactionsImported: 0,
        skipped,
        message: `All ${rawTransactions.length} Monarch transactions were already imported or pending.`,
      });
    }

    // 5. Bulk insert
    const count = insertTransactions(database, txns);

    // 6. Compute date range
    const dates = txns.map((t) => t.date).sort();
    const dateRangeStart = dates[0];
    const dateRangeEnd = dates[dates.length - 1];

    // 7. Record the import (use timestamp-based hash since there's no file)
    const importHash = `monarch-sync-${new Date().toISOString()}`;
    recordImport(database, {
      file_path: 'monarch-sync',
      file_hash: importHash,
      bank: 'monarch',
      transaction_count: count,
      date_range_start: dateRangeStart,
      date_range_end: dateRangeEnd,
    });

    return formatToolResult({
      success: true,
      transactionsImported: count,
      skipped,
      totalFetched: rawTransactions.length,
      dateRange: { start: dateRangeStart, end: dateRangeEnd },
      message: `Imported ${count} transactions from Monarch Money (${dateRangeStart} to ${dateRangeEnd}). Skipped ${skipped} (duplicates or pending).`,
    });
  },
});
