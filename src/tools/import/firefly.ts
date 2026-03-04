import { z } from 'zod';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { insertTransactions, recordImport, type TransactionInsert } from '../../db/queries.js';
import { getAccounts, linkTransactionsToAccount } from '../../db/net-worth-queries.js';
import { formatToolResult } from '../types.js';
import { hasLicense } from '../../licensing/license.js';
import { toolUpsell } from '../../licensing/upsell.js';

// Module-level database reference
let db: Database | null = null;

/**
 * Initialize the firefly_import tool with a database connection.
 * Must be called before the agent starts.
 */
export function initFireflyTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) {
    throw new Error('firefly_import tool not initialized. Call initFireflyTool(database) first.');
  }
  return db;
}

/** A single split within a Firefly III transaction group. */
interface FireflyTransactionSplit {
  transaction_journal_id: string;
  type: 'withdrawal' | 'deposit' | 'transfer' | 'reconciliation' | 'opening balance';
  date: string;
  amount: string;
  description: string;
  source_name: string | null;
  destination_name: string | null;
  category_name: string | null;
  budget_name: string | null;
  bill_name: string | null;
  tags: string[] | null;
  notes: string | null;
  internal_reference: string | null;
  external_url: string | null;
  /** Firefly III v3.x field */
  subscription_name?: string | null;
}

/** A transaction group (read) from the Firefly III API. */
interface FireflyTransactionRead {
  type: 'transactions';
  id: string;
  attributes: {
    group_title: string | null;
    transactions: FireflyTransactionSplit[];
  };
}

/** Top-level Firefly III list response. */
interface FireflyTransactionArray {
  data: FireflyTransactionRead[];
  meta: {
    pagination: FireflyPagination;
  };
}

interface FireflyPagination {
  total: number;
  count: number;
  per_page: number;
  current_page: number;
  total_pages: number;
}

/**
 * Fetch all transactions from Firefly III, paginating until done.
 */
async function fetchFireflyTransactions(opts: {
  startDate?: string;
  endDate?: string;
  limit?: number;
}): Promise<FireflyTransactionSplit[]> {
  const baseUrl = process.env.FIREFLY_API_URL!.replace(/\/+$/, '');
  const token = process.env.FIREFLY_API_TOKEN!;
  const allSplits: FireflyTransactionSplit[] = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams({ type: 'default', page: String(page) });
    if (opts.startDate) params.set('start', opts.startDate);
    if (opts.endDate) params.set('end', opts.endDate);

    const res = await fetch(`${baseUrl}/api/v1/transactions?${params}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.api+json',
      },
    });

    if (!res.ok) {
      throw new Error(`Firefly API responded with ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as FireflyTransactionArray;

    for (const group of body.data) {
      for (const split of group.attributes.transactions) {
        allSplits.push(split);
        if (opts.limit && allSplits.length >= opts.limit) {
          return allSplits;
        }
      }
    }

    const { current_page, total_pages } = body.meta.pagination;
    if (current_page >= total_pages) break;
    page++;
  }

  return allSplits;
}

/**
 * Firefly III import tool — fetches transactions from a self-hosted
 * Firefly III instance, maps to OA's schema, and bulk-inserts.
 */
export const fireflyImportTool = defineTool({
  name: 'firefly_import',
  description:
    'Import transactions from a self-hosted Firefly III instance. Requires FIREFLY_API_URL and FIREFLY_API_TOKEN env vars. ' +
    'Fetches transactions via Firefly III REST API and imports them into the local database.',
  schema: z.object({
    limit: z
      .number()
      .optional()
      .describe('Max transactions to fetch (default: all)'),
    startDate: z
      .string()
      .optional()
      .describe('Start date filter (YYYY-MM-DD)'),
    endDate: z
      .string()
      .optional()
      .describe('End date filter (YYYY-MM-DD)'),
    includeTransfers: z
      .boolean()
      .optional()
      .describe('Include transfer transactions (default: false)'),
  }),
  func: async ({ limit, startDate, endDate, includeTransfers = false }) => {
    if (!hasLicense('pro')) return toolUpsell('Firefly III import');

    const database = getDb();

    // Check env vars
    if (!process.env.FIREFLY_API_URL || !process.env.FIREFLY_API_TOKEN) {
      return formatToolResult({
        error:
          'Firefly III credentials not configured. Set FIREFLY_API_URL and FIREFLY_API_TOKEN in your environment.',
      });
    }

    // 1. Fetch transactions
    let rawSplits: FireflyTransactionSplit[];
    try {
      rawSplits = await fetchFireflyTransactions({ startDate, endDate, limit });
    } catch (err) {
      return formatToolResult({
        error: `Failed to fetch Firefly III transactions: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (rawSplits.length === 0) {
      return formatToolResult({
        transactionsImported: 0,
        message: 'No transactions found in Firefly III for the given filters.',
      });
    }

    // 2. Build dedup sets — primary by external_id, fallback by composite key
    const existingIds = new Set<string>();
    const existingComposite = new Set<string>();

    const existingRows = database
      .prepare(
        `SELECT date, description, amount, external_id FROM transactions WHERE bank = 'firefly'`,
      )
      .all() as { date: string; description: string; amount: number; external_id: string | null }[];

    for (const row of existingRows) {
      if (row.external_id) existingIds.add(row.external_id);
      existingComposite.add(`${row.date}|${row.description}|${row.amount}`);
    }

    // 3. Map to OA's schema and deduplicate
    const txns: TransactionInsert[] = [];
    let skipped = 0;

    for (const split of rawSplits) {
      // Skip reconciliation and opening balance types
      if (split.type === 'reconciliation' || split.type === 'opening balance') {
        skipped++;
        continue;
      }

      // Skip transfers unless explicitly included
      if (split.type === 'transfer' && !includeTransfers) {
        skipped++;
        continue;
      }

      const externalId = `firefly:${split.transaction_journal_id}`;

      // Primary dedup: by external_id
      if (existingIds.has(externalId)) {
        skipped++;
        continue;
      }

      // Amount: Firefly amounts are always positive strings; direction from type
      const rawAmount = parseFloat(split.amount);
      let amount: number;
      if (split.type === 'withdrawal' || split.type === 'transfer') {
        amount = -Math.abs(rawAmount); // expense
      } else {
        amount = Math.abs(rawAmount); // deposit = income
      }

      const date = split.date.slice(0, 10); // ISO 8601 → YYYY-MM-DD

      // Merchant: destination for withdrawals, source for deposits
      const description =
        split.type === 'withdrawal'
          ? split.destination_name || split.description
          : split.type === 'deposit'
            ? split.source_name || split.description
            : split.description;

      // Fallback dedup: composite key
      const compositeKey = `${date}|${description}|${amount}`;
      if (existingComposite.has(compositeKey)) {
        skipped++;
        continue;
      }

      // Recurring detection
      const isRecurring = split.bill_name || split.subscription_name ? 1 : 0;

      // Tags
      const tags = split.tags && split.tags.length > 0 ? split.tags.join(', ') : undefined;

      // For withdrawals, source_name is the user's account; for deposits, destination_name
      const accountName =
        split.type === 'withdrawal' ? split.source_name
        : split.type === 'deposit' ? split.destination_name
        : undefined;

      txns.push({
        date,
        description,
        amount,
        category: split.category_name ?? undefined,
        bank: 'firefly',
        source_file: 'firefly-sync',
        is_recurring: isRecurring,
        notes: split.notes ?? undefined,
        tags,
        external_id: externalId,
        merchant_name: description,
        account_name: accountName ?? undefined,
      });
    }

    if (txns.length === 0) {
      return formatToolResult({
        transactionsImported: 0,
        skipped,
        message: `All ${rawSplits.length} Firefly III transactions were already imported or filtered.`,
      });
    }

    // 4. Bulk insert
    const count = insertTransactions(database, txns);

    // 4b. Auto-link transactions to accounts by account_name
    let autoLinked = 0;
    const accountNames = new Set(txns.map((t) => t.account_name).filter(Boolean));
    if (accountNames.size > 0) {
      const accounts = getAccounts(database, { active: true });
      for (const acct of accounts) {
        if (accountNames.has(acct.name)) {
          autoLinked += linkTransactionsToAccount(database, acct.id, { accountName: acct.name });
        }
      }
    }

    // 5. Compute date range
    const dates = txns.map((t) => t.date).sort();
    const dateRangeStart = dates[0];
    const dateRangeEnd = dates[dates.length - 1];

    // 6. Record the import
    const importHash = `firefly-sync-${new Date().toISOString()}`;
    recordImport(database, {
      file_path: 'firefly-sync',
      file_hash: importHash,
      bank: 'firefly',
      transaction_count: count,
      date_range_start: dateRangeStart,
      date_range_end: dateRangeEnd,
    });

    return formatToolResult({
      success: true,
      transactionsImported: count,
      autoLinked,
      skipped,
      totalFetched: rawSplits.length,
      dateRange: { start: dateRangeStart, end: dateRangeEnd },
      message: `Imported ${count} transactions from Firefly III (${dateRangeStart} to ${dateRangeEnd}). Skipped ${skipped} (duplicates, transfers, or filtered).${autoLinked > 0 ? ` Auto-linked ${autoLinked} to accounts.` : ''}`,
    });
  },
});
