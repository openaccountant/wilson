import { z } from 'zod';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { parse } from 'csv-parse/sync';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { detectBank, type BankType } from './detect-bank.js';
import { parseChaseCSV } from './parsers/chase.js';
import { parseAmexCSV } from './parsers/amex.js';
import { parseGenericCSV } from './parsers/generic.js';
import type { ParsedTransaction } from './parsers/chase.js';
import {
  insertTransactions,
  checkImported,
  recordImport,
  type TransactionInsert,
} from '../../db/queries.js';
import { formatToolResult } from '../types.js';

// Module-level database reference
let db: Database | null = null;

/**
 * Initialize the csv_import tool with a database connection.
 * Must be called before the agent starts.
 */
export function initImportTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) {
    throw new Error('csv_import tool not initialized. Call initImportTool(database) first.');
  }
  return db;
}

/**
 * CSV Import tool — reads a bank CSV, detects the bank format, parses transactions,
 * and bulk-inserts them into the database. Deduplicates by file hash.
 */
export const csvImportTool = defineTool({
  name: 'csv_import',
  description:
    'Import transactions from a bank CSV file. Auto-detects Chase, Amex, or generic CSV format. ' +
    'Prevents duplicate imports by tracking file hashes.',
  schema: z.object({
    filePath: z.string().describe('Path to bank CSV file'),
    bank: z
      .enum(['chase', 'amex', 'auto'])
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

    // 2. Check if already imported
    const existing = checkImported(database, fileHash);
    if (existing) {
      return formatToolResult({
        alreadyImported: true,
        importedAt: existing.imported_at,
        transactionCount: existing.transaction_count,
        message: `This file was already imported on ${existing.imported_at} (${existing.transaction_count} transactions).`,
      });
    }

    // 3. Detect bank from CSV headers
    let detectedBank: BankType;
    if (bank && bank !== 'auto') {
      detectedBank = bank;
    } else {
      // Parse just the header row to detect bank
      const headerRecords = parse(content, {
        columns: true,
        to: 1,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      }) as Record<string, string>[];

      if (headerRecords.length === 0) {
        return formatToolResult({ error: 'CSV file appears to be empty or has no valid rows.' });
      }

      const headers = Object.keys(headerRecords[0]);
      detectedBank = detectBank(headers);
    }

    // 4. Parse with appropriate parser
    let parsed: ParsedTransaction[];
    try {
      switch (detectedBank) {
        case 'chase':
          parsed = parseChaseCSV(content);
          break;
        case 'amex':
          parsed = parseAmexCSV(content);
          break;
        default:
          parsed = parseGenericCSV(content);
          break;
      }
    } catch (err) {
      return formatToolResult({
        error: `Failed to parse CSV: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (parsed.length === 0) {
      return formatToolResult({ error: 'No valid transactions found in the CSV file.' });
    }

    // 5. Convert to insert format
    const txns: TransactionInsert[] = parsed.map((t) => ({
      date: t.date,
      description: t.description,
      amount: t.amount,
      bank: t.bank,
      source_file: filePath,
    }));

    // 6. Bulk insert
    const count = insertTransactions(database, txns);

    // 7. Compute date range
    const dates = parsed.map((t) => t.date).sort();
    const dateRangeStart = dates[0];
    const dateRangeEnd = dates[dates.length - 1];

    // 8. Record the import
    recordImport(database, {
      file_path: filePath,
      file_hash: fileHash,
      bank: detectedBank,
      transaction_count: count,
      date_range_start: dateRangeStart,
      date_range_end: dateRangeEnd,
    });

    return formatToolResult({
      success: true,
      transactionsImported: count,
      bankDetected: detectedBank,
      dateRange: { start: dateRangeStart, end: dateRangeEnd },
      message: `Imported ${count} transactions from ${detectedBank} CSV (${dateRangeStart} to ${dateRangeEnd}).`,
    });
  },
});
