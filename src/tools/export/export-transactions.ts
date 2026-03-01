import { z } from 'zod';
import * as XLSX from 'xlsx';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { getTransactions, type TransactionFilters } from '../../db/queries.js';
import { formatToolResult } from '../types.js';

// Module-level database reference
let db: Database | null = null;

/**
 * Initialize the export_transactions tool with a database connection.
 * Must be called before the agent starts.
 */
export function initExportTool(dbInstance: Database): void {
  db = dbInstance;
}

function getDb(): Database {
  if (!db) {
    throw new Error('export_transactions tool not initialized. Call initExportTool(database) first.');
  }
  return db;
}

/**
 * Export Transactions tool — queries transactions from the database with optional
 * filters and writes them to a CSV or XLSX file.
 */
export const exportTransactionsTool = defineTool({
  name: 'export_transactions',
  description:
    'Export transactions to a CSV or XLSX file. Supports filtering by date range, category, ' +
    'and merchant/description. Useful for sharing data or creating reports.',
  schema: z.object({
    format: z.enum(['csv', 'xlsx']).describe('Export file format'),
    filePath: z.string().describe('Output file path'),
    dateStart: z.string().optional().describe('Start date filter (YYYY-MM-DD)'),
    dateEnd: z.string().optional().describe('End date filter (YYYY-MM-DD)'),
    category: z.string().optional().describe('Category filter'),
    merchant: z.string().optional().describe('Merchant/description filter'),
  }),
  func: async ({ format, filePath, dateStart, dateEnd, category, merchant }) => {
    const database = getDb();

    // Resolve ~ to home directory
    const resolvedPath = filePath.startsWith('~')
      ? filePath.replace('~', process.env.HOME ?? '')
      : filePath;

    // Build filters from args
    const filters: TransactionFilters = {};
    if (dateStart) filters.dateStart = dateStart;
    if (dateEnd) filters.dateEnd = dateEnd;
    if (category) filters.category = category;
    if (merchant) filters.merchant = merchant;

    // Query transactions
    const transactions = getTransactions(database, filters);

    if (transactions.length === 0) {
      return formatToolResult({
        success: false,
        message: 'No transactions found matching the specified filters.',
      });
    }

    // Select useful columns for export
    const rows = transactions.map((t) => ({
      date: t.date,
      description: t.description,
      amount: t.amount,
      category: t.category ?? '',
    }));

    // Create workbook and worksheet
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Transactions');

    // Write file
    try {
      XLSX.writeFile(wb, resolvedPath, { bookType: format });
    } catch (err) {
      return formatToolResult({
        error: `Failed to write file: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    return formatToolResult({
      success: true,
      transactionsExported: transactions.length,
      format,
      filePath: resolvedPath,
      message: `Exported ${transactions.length} transactions to ${resolvedPath} (${format.toUpperCase()}).`,
    });
  },
});
