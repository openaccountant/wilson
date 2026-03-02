import { z } from 'zod';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { updateTransaction, getTransactionById } from '../../db/queries.js';
import { formatToolResult } from '../types.js';

let db: Database | null = null;

export function initEditTransactionTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) {
    throw new Error('edit_transaction tool not initialized. Call initEditTransactionTool(database) first.');
  }
  return db;
}

export const editTransactionTool = defineTool({
  name: 'edit_transaction',
  description:
    'Edit a transaction by ID. Can update date, description, amount, category, or notes. ' +
    'Use transaction_search first to find the transaction ID.',
  schema: z.object({
    id: z.number().describe('Transaction ID to edit'),
    date: z.string().optional().describe('New date (YYYY-MM-DD)'),
    description: z.string().optional().describe('New description'),
    amount: z.number().optional().describe('New amount (negative=expense, positive=income)'),
    category: z.string().optional().describe('New category'),
    notes: z.string().optional().describe('New notes'),
  }),
  func: async ({ id, date, description, amount, category, notes }) => {
    const database = getDb();

    const txn = getTransactionById(database, id);
    if (!txn) {
      return formatToolResult({ success: false, message: `Transaction #${id} not found.` });
    }

    const updates = { date, description, amount, category, notes };
    // Remove undefined keys
    const filtered = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));

    if (Object.keys(filtered).length === 0) {
      return formatToolResult({ success: false, message: 'No fields to update.' });
    }

    const success = updateTransaction(database, id, filtered);
    const updated = getTransactionById(database, id);

    return formatToolResult({
      success,
      message: success
        ? `Updated transaction #${id}: ${updated?.description} (${updated?.date}, $${updated?.amount})`
        : `Failed to update transaction #${id}.`,
      transaction: updated,
    });
  },
});
