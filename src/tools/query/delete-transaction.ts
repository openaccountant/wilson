import { z } from 'zod';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { deleteTransaction, getTransactionById } from '../../db/queries.js';
import { formatToolResult } from '../types.js';

let db: Database | null = null;

export function initDeleteTransactionTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) {
    throw new Error('delete_transaction tool not initialized. Call initDeleteTransactionTool(database) first.');
  }
  return db;
}

export const deleteTransactionTool = defineTool({
  name: 'delete_transaction',
  description:
    'Delete a transaction by ID. This is permanent. ' +
    'Use transaction_search first to find the transaction ID.',
  schema: z.object({
    id: z.number().describe('Transaction ID to delete'),
  }),
  func: async ({ id }) => {
    const database = getDb();

    const txn = getTransactionById(database, id);
    if (!txn) {
      return formatToolResult({ success: false, message: `Transaction #${id} not found.` });
    }

    const success = deleteTransaction(database, id);

    return formatToolResult({
      success,
      message: success
        ? `Deleted transaction #${id}: ${txn.description} (${txn.date}, $${txn.amount})`
        : `Failed to delete transaction #${id}.`,
    });
  },
});
