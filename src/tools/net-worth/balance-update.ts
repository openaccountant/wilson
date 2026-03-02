import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import type { Database } from '../../db/compat-sqlite.js';
import { updateAccountBalance, getAccountById } from '../../db/net-worth-queries.js';

let db: Database;

export function initBalanceUpdateTool(database: Database) {
  db = database;
}

export const balanceUpdateTool = defineTool({
  name: 'balance_update',
  description: 'Update the current balance of a financial account and record a snapshot.',
  schema: z.object({
    accountId: z.number().describe('Account ID to update'),
    balance: z.number().describe('New balance (always positive)'),
    source: z.string().optional().describe('Source of the balance update (manual, plaid, etc.)'),
  }),
  func: async ({ accountId, balance, source }) => {
    const account = getAccountById(db, accountId);
    if (!account) return formatToolResult({ error: `Account #${accountId} not found` });

    const previousBalance = account.current_balance;
    updateAccountBalance(db, accountId, balance, source ?? 'manual');

    const change = balance - previousBalance;
    const changeStr = change >= 0 ? `+$${change.toFixed(2)}` : `-$${Math.abs(change).toFixed(2)}`;

    return formatToolResult({
      message: `${account.name} balance updated to $${balance.toFixed(2)} (${changeStr})`,
      accountId,
      previousBalance,
      newBalance: balance,
      change,
    });
  },
});
