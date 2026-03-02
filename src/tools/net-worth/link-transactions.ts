import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import type { Database } from '../../db/compat-sqlite.js';
import { linkTransactionsToAccount, getAccountById } from '../../db/net-worth-queries.js';

let db: Database;

export function initLinkTransactionsTool(database: Database) {
  db = database;
}

export const linkTransactionsTool = defineTool({
  name: 'link_transactions',
  description: 'Link unlinked transactions to an account by matching account_last4, bank, or account_name.',
  schema: z.object({
    accountId: z.number().describe('Account ID to link transactions to'),
    accountLast4: z.string().optional().describe('Match transactions with this last4 digits'),
    bank: z.string().optional().describe('Match transactions from this bank'),
    accountName: z.string().optional().describe('Match transactions with this account_name'),
    dryRun: z.boolean().optional().describe('If true, report matches without modifying'),
  }),
  func: async ({ accountId, accountLast4, bank, accountName, dryRun }) => {
    const account = getAccountById(db, accountId);
    if (!account) return formatToolResult({ error: `Account #${accountId} not found` });

    if (!accountLast4 && !bank && !accountName) {
      return formatToolResult({ error: 'At least one matching criterion is required (accountLast4, bank, or accountName)' });
    }

    if (dryRun) {
      // Count matches without modifying
      const conditions: string[] = ['account_id IS NULL'];
      const params: Record<string, unknown> = {};
      if (accountLast4) { conditions.push('account_last4 = @accountLast4'); params.accountLast4 = accountLast4; }
      if (bank) { conditions.push('bank = @bank'); params.bank = bank; }
      if (accountName) { conditions.push('account_name = @accountName'); params.accountName = accountName; }

      const row = db.prepare(
        `SELECT COUNT(*) AS count FROM transactions WHERE ${conditions.join(' AND ')}`
      ).get(params) as { count: number };

      return formatToolResult({
        dryRun: true,
        matchCount: row.count,
        message: `${row.count} unlinked transactions would be linked to ${account.name}`,
      });
    }

    const count = linkTransactionsToAccount(db, accountId, { accountLast4, bank, accountName });
    return formatToolResult({
      linked: count,
      message: `${count} transactions linked to ${account.name}`,
    });
  },
});
