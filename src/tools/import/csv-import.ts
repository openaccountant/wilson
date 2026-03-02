import { z } from 'zod';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { parse } from 'csv-parse/sync';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { detectBank, detectFormat, type BankType } from './detect-bank.js';
import { parseChaseCSV } from './parsers/chase.js';
import { parseAmexCSV } from './parsers/amex.js';
import { parseGenericCSV } from './parsers/generic.js';
import { parseOfx } from './parsers/ofx.js';
import { parseQif } from './parsers/qif.js';
import { parseBofA } from './parsers/bofa.js';
import type { ParsedTransaction } from './parsers/chase.js';
import {
  insertTransactions,
  checkImported,
  checkExternalId,
  recordImport,
  type TransactionInsert,
} from '../../db/queries.js';
import { linkTransactionsToAccount } from '../../db/net-worth-queries.js';
import { formatToolResult } from '../types.js';

// Module-level database reference
let db: Database | null = null;

/**
 * Initialize the file_import tool with a database connection.
 * Must be called before the agent starts.
 */
export function initImportTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) {
    throw new Error('file_import tool not initialized. Call initImportTool(database) first.');
  }
  return db;
}

/**
 * Compute a per-row external_id for CSV transactions that don't have one.
 * Uses SHA-256 of date+description+amount to enable per-transaction dedup.
 */
function computeExternalId(t: ParsedTransaction): string {
  return `csv-${createHash('sha256').update(`${t.date}|${t.description}|${t.amount}`).digest('hex').slice(0, 16)}`;
}

/**
 * Convert a ParsedTransaction to a TransactionInsert, mapping all available fields.
 */
function toInsert(t: ParsedTransaction, filePath: string): TransactionInsert {
  return {
    date: t.date,
    description: t.description,
    amount: t.amount,
    bank: t.bank,
    source_file: filePath,
    merchant_name: t.merchant_name ?? undefined,
    category: t.category ?? undefined,
    category_detailed: t.category_detailed ?? undefined,
    external_id: t.external_id ?? undefined,
    payment_channel: t.payment_channel ?? undefined,
    pending: t.pending ? 1 : 0,
    authorized_date: t.authorized_date ?? undefined,
  };
}

/**
 * File Import tool — reads a bank file (CSV, OFX, or QIF), detects the format
 * and bank, parses transactions, and bulk-inserts them into the database.
 * Deduplicates by file hash and per-transaction external_id.
 */
export const csvImportTool = defineTool({
  name: 'csv_import',
  description:
    'Import transactions from a bank file (CSV, OFX, or QIF). Auto-detects file format ' +
    'and bank (Chase, Amex, BofA, generic). Prevents duplicates by file hash and per-transaction ID.',
  schema: z.object({
    filePath: z.string().describe('Path to bank file (CSV, OFX, or QIF)'),
    bank: z
      .enum(['chase', 'amex', 'bofa', 'auto'])
      .optional()
      .describe('Bank name (auto-detects if omitted)'),
  }),
  func: async ({ filePath, bank }) => {
    const database = getDb();

    // 1. Read file and compute SHA-256 hash
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (err) {
      return formatToolResult({
        error: `Could not read file: ${filePath}. ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const fileHash = createHash('sha256').update(content).digest('hex');

    // 2. Check if already imported (file-level dedup)
    const existing = checkImported(database, fileHash);
    if (existing) {
      return formatToolResult({
        alreadyImported: true,
        importedAt: existing.imported_at,
        transactionCount: existing.transaction_count,
        message: `This file was already imported on ${existing.imported_at} (${existing.transaction_count} transactions).`,
      });
    }

    // 3. Detect file format and bank
    const detected = detectFormat(content);
    let detectedBank: BankType = detected.bank ?? 'generic';

    // Override bank if explicitly specified (only for CSV)
    if (bank && bank !== 'auto' && detected.format === 'csv') {
      detectedBank = bank;
    }

    // 4. Parse with appropriate parser
    let parsed: ParsedTransaction[];
    try {
      switch (detected.format) {
        case 'ofx':
          parsed = parseOfx(content);
          break;
        case 'qif':
          parsed = parseQif(content);
          break;
        case 'csv':
          switch (detectedBank) {
            case 'chase':
              parsed = parseChaseCSV(content);
              break;
            case 'amex':
              parsed = parseAmexCSV(content);
              break;
            case 'bofa':
            case 'bofa-cc':
              parsed = parseBofA(content);
              break;
            default:
              parsed = parseGenericCSV(content);
              break;
          }
          break;
        default:
          parsed = parseGenericCSV(content);
          break;
      }
    } catch (err) {
      return formatToolResult({
        error: `Failed to parse file: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (parsed.length === 0) {
      return formatToolResult({ error: 'No valid transactions found in the file.' });
    }

    // 5. Assign external_id to CSV transactions that don't have one
    for (const t of parsed) {
      if (!t.external_id) {
        t.external_id = computeExternalId(t);
      }
    }

    // 6. Per-transaction dedup via external_id
    const newParsed: ParsedTransaction[] = [];
    let skipped = 0;
    for (const t of parsed) {
      if (t.external_id && checkExternalId(database, t.external_id)) {
        skipped++;
      } else {
        newParsed.push(t);
      }
    }

    if (newParsed.length === 0) {
      return formatToolResult({
        alreadyImported: true,
        transactionCount: parsed.length,
        skipped,
        message: `All ${parsed.length} transactions already exist (skipped as duplicates).`,
      });
    }

    // 7. Convert to insert format with all new fields
    const txns: TransactionInsert[] = newParsed.map((t) => toInsert(t, filePath));

    // 8. Bulk insert
    const count = insertTransactions(database, txns);

    // 9. Compute date range
    const dates = newParsed.map((t) => t.date).sort();
    const dateRangeStart = dates[0];
    const dateRangeEnd = dates[dates.length - 1];

    // 10. Record the import
    recordImport(database, {
      file_path: filePath,
      file_hash: fileHash,
      bank: detectedBank,
      transaction_count: count,
      date_range_start: dateRangeStart,
      date_range_end: dateRangeEnd,
    });

    // Auto-link newly imported transactions to accounts by account_last4
    let autoLinked = 0;
    const last4Values = [...new Set(txns.map((t) => t.account_last4 ?? null).filter(Boolean))] as string[];
    for (const last4 of last4Values) {
      const account = database.prepare(
        'SELECT id FROM accounts WHERE account_number_last4 = @last4 AND is_active = 1'
      ).get({ last4 }) as { id: number } | undefined;
      if (account) {
        autoLinked += linkTransactionsToAccount(database, account.id, { accountLast4: last4 });
      }
    }

    const formatLabel = detected.format === 'csv' ? `${detectedBank} CSV` : detected.format.toUpperCase();
    let message = `Imported ${count} transactions from ${formatLabel} (${dateRangeStart} to ${dateRangeEnd}).`;
    if (skipped > 0) message += ` ${skipped} duplicates skipped.`;
    if (autoLinked > 0) message += ` ${autoLinked} transactions auto-linked to accounts.`;

    return formatToolResult({
      success: true,
      transactionsImported: count,
      transactionsSkipped: skipped,
      transactionsLinked: autoLinked,
      formatDetected: detected.format,
      bankDetected: detectedBank,
      dateRange: { start: dateRangeStart, end: dateRangeEnd },
      message,
    });
  },
});
