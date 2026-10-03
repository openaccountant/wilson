import { z } from 'zod';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
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
import { computeExternalId } from './external-id.js';
import {
  insertTransactions,
  checkImported,
  checkExternalId,
  recordImport,
  type TransactionInsert,
} from '../../db/queries.js';
import { linkTransactionsToAccount } from '../../db/net-worth-queries.js';
import { embedTransactionIds } from '../../utils/embed-on-write.js';
import { formatToolResult } from '../types.js';

const IMPORTABLE_EXTENSIONS = new Set(['.csv', '.ofx', '.qif']);

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
    account_name: t.account_name ?? undefined,
  };
}

interface SingleFileResult {
  status: 'imported' | 'skipped' | 'failed';
  file: string;
  transactionsImported: number;
  transactionsSkipped: number;
  transactionsLinked: number;
  bankDetected?: string;
  formatDetected?: string;
  dateRange?: { start: string; end: string };
  message: string;
  error?: string;
}

async function importSingleFile(
  database: Database,
  filePath: string,
  bank?: 'chase' | 'amex' | 'bofa' | 'auto',
): Promise<SingleFileResult> {
  // 1. Read file and compute SHA-256 hash
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return {
      status: 'failed',
      file: filePath,
      transactionsImported: 0,
      transactionsSkipped: 0,
      transactionsLinked: 0,
      message: `Could not read file: ${filePath}`,
      error: `Could not read file: ${filePath}. ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const fileHash = createHash('sha256').update(content).digest('hex');

  // 2. Check if already imported (file-level dedup)
  const existing = checkImported(database, fileHash);
  if (existing) {
    return {
      status: 'skipped',
      file: filePath,
      transactionsImported: 0,
      transactionsSkipped: existing.transaction_count ?? 0,
      transactionsLinked: 0,
      message: `This file was already imported on ${existing.imported_at} (${existing.transaction_count} transactions).`,
    };
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
    return {
      status: 'failed',
      file: filePath,
      transactionsImported: 0,
      transactionsSkipped: 0,
      transactionsLinked: 0,
      message: `Failed to parse file: ${filePath}`,
      error: `Failed to parse file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (parsed.length === 0) {
    return {
      status: 'failed',
      file: filePath,
      transactionsImported: 0,
      transactionsSkipped: 0,
      transactionsLinked: 0,
      message: 'No valid transactions found in the file.',
      error: 'No valid transactions found in the file.',
    };
  }

  // 5. Assign external_id to CSV transactions that don't have one
  for (const t of parsed) {
    if (!t.external_id) {
      t.external_id = computeExternalId(t);
    }
  }

  // 6. Per-transaction dedup via external_id — against both the DB and this
  // same batch. Some exports (e.g. Quicken) legitimately contain two rows
  // that hash to the same id (identical date/description/amount), which
  // would otherwise pass this DB-only check and then crash the bulk insert
  // below with a UNIQUE constraint violation.
  const newParsed: ParsedTransaction[] = [];
  const seenInBatch = new Set<string>();
  let skipped = 0;
  for (const t of parsed) {
    const isDuplicate =
      !!t.external_id && (checkExternalId(database, t.external_id) || seenInBatch.has(t.external_id));
    if (isDuplicate) {
      skipped++;
    } else {
      if (t.external_id) seenInBatch.add(t.external_id);
      newParsed.push(t);
    }
  }

  if (newParsed.length === 0) {
    return {
      status: 'skipped',
      file: filePath,
      transactionsImported: 0,
      transactionsSkipped: skipped,
      transactionsLinked: 0,
      message: `All ${parsed.length} transactions already exist (skipped as duplicates).`,
    };
  }

  // 7. Convert to insert format with all new fields
  const txns: TransactionInsert[] = newParsed.map((t) => toInsert(t, filePath));

  // 8. Bulk insert + embed-on-write: index the new rows immediately so they are
  // semantically searchable without a backfill run. Never fails the import.
  const { count, ids } = insertTransactions(database, txns);
  await embedTransactionIds(database, ids);

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

  // Some formats name the account per row instead of a last4 (e.g. Quicken's
  // combined multi-account "Transaction Report" CSV — see generic.ts). Every
  // imported row already carries that name for display even if unlinked, but
  // try to auto-link it to a matching tracked account too (case-insensitive,
  // only when exactly one active account matches — an ambiguous name is left
  // for the user to resolve via `link_transactions` rather than guessed at).
  const accountNames = [...new Set(txns.map((t) => t.account_name ?? null).filter(Boolean))] as string[];
  for (const name of accountNames) {
    const matches = database.prepare(
      'SELECT id, name FROM accounts WHERE is_active = 1 AND LOWER(name) = LOWER(@name)'
    ).all({ name }) as { id: number; name: string }[];
    if (matches.length === 1) {
      autoLinked += linkTransactionsToAccount(database, matches[0].id, { accountName: name });
    }
  }

  const formatLabel = detected.format === 'csv' ? `${detectedBank} CSV` : detected.format.toUpperCase();
  let message = `Imported ${count} transactions from ${formatLabel} (${dateRangeStart} to ${dateRangeEnd}).`;
  if (skipped > 0) message += ` ${skipped} duplicates skipped.`;
  if (autoLinked > 0) message += ` ${autoLinked} transactions auto-linked to accounts.`;

  return {
    status: 'imported',
    file: filePath,
    transactionsImported: count,
    transactionsSkipped: skipped,
    transactionsLinked: autoLinked,
    formatDetected: detected.format,
    bankDetected: detectedBank,
    dateRange: { start: dateRangeStart, end: dateRangeEnd },
    message,
  };
}

/**
 * File Import tool — reads a bank file or directory of bank files (CSV, OFX, or QIF),
 * detects the format and bank, parses transactions, and bulk-inserts them into the database.
 * Deduplicates by file hash and per-transaction external_id.
 */
export const csvImportTool = defineTool({
  name: 'csv_import',
  description:
    'Import transactions from a bank file or directory (CSV, OFX, or QIF). Auto-detects file format ' +
    'and bank (Chase, Amex, BofA, generic). Prevents duplicates by file hash and per-transaction ID. ' +
    'When given a directory, imports all valid files (.csv, .ofx, .qif) within it.',
  schema: z.object({
    filePath: z.string().describe('Path to a bank file (CSV, OFX, or QIF) or a directory containing them'),
    bank: z
      .enum(['chase', 'amex', 'bofa', 'auto'])
      .optional()
      .describe('Bank name (auto-detects if omitted)'),
  }),
  func: async ({ filePath: rawPath, bank }) => {
    const database = getDb();

    // Strip leading @ from file autocomplete and surrounding quotes
    const cleanPath = rawPath.replace(/^["']|["']$/g, '').replace(/^@/, '');

    // Check if path is a directory
    let isDir = false;
    try {
      isDir = statSync(cleanPath).isDirectory();
    } catch {
      // statSync failed — fall through to importSingleFile which will report the read error
    }

    if (!isDir) {
      // Single file import
      const result = await importSingleFile(database, cleanPath, bank);
      if (result.status === 'failed') {
        return formatToolResult({ error: result.error ?? result.message });
      }
      if (result.status === 'skipped') {
        return formatToolResult({
          alreadyImported: true,
          transactionCount: result.transactionsSkipped,
          skipped: result.transactionsSkipped,
          message: result.message,
        });
      }
      return formatToolResult({
        success: true,
        transactionsImported: result.transactionsImported,
        transactionsSkipped: result.transactionsSkipped,
        transactionsLinked: result.transactionsLinked,
        formatDetected: result.formatDetected,
        bankDetected: result.bankDetected,
        dateRange: result.dateRange,
        message: result.message,
      });
    }

    // Directory import
    let entries: string[];
    try {
      entries = readdirSync(cleanPath);
    } catch (err) {
      return formatToolResult({
        error: `Could not read directory: ${cleanPath}. ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const importableFiles = entries
      .filter((f) => IMPORTABLE_EXTENSIONS.has(extname(f).toLowerCase()))
      .map((f) => join(cleanPath, f))
      .sort();

    if (importableFiles.length === 0) {
      return formatToolResult({
        error: `No importable files (.csv, .ofx, .qif) found in directory: ${cleanPath}`,
      });
    }

    const results: SingleFileResult[] = [];
    for (const file of importableFiles) {
      results.push(await importSingleFile(database, file, bank));
    }

    const imported = results.filter((r) => r.status === 'imported');
    const skipped = results.filter((r) => r.status === 'skipped');
    const failed = results.filter((r) => r.status === 'failed');

    const totalImported = results.reduce((s, r) => s + r.transactionsImported, 0);
    const totalSkipped = results.reduce((s, r) => s + r.transactionsSkipped, 0);
    const totalLinked = results.reduce((s, r) => s + r.transactionsLinked, 0);

    const parts: string[] = [];
    parts.push(`Directory: ${cleanPath}`);
    parts.push(`Files found: ${importableFiles.length}, imported: ${imported.length}, skipped: ${skipped.length}, failed: ${failed.length}`);
    parts.push(`Transactions imported: ${totalImported}, skipped: ${totalSkipped}, linked: ${totalLinked}`);
    if (failed.length > 0) {
      parts.push(`Failures: ${failed.map((r) => `${r.file}: ${r.error}`).join('; ')}`);
    }

    return formatToolResult({
      success: imported.length > 0,
      directory: cleanPath,
      filesFound: importableFiles.length,
      filesImported: imported.length,
      filesSkipped: skipped.length,
      filesFailed: failed.length,
      totalTransactionsImported: totalImported,
      totalTransactionsSkipped: totalSkipped,
      totalTransactionsLinked: totalLinked,
      fileResults: results.map((r) => ({ file: r.file, status: r.status, message: r.message })),
      message: parts.join('. ') + '.',
    });
  },
});
