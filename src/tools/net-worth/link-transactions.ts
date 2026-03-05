import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import type { Database } from '../../db/compat-sqlite.js';
import { linkTransactionsToAccount, getAccountById, getAccounts } from '../../db/net-worth-queries.js';

let db: Database;

export function initLinkTransactionsTool(database: Database) {
  db = database;
}

export const linkTransactionsTool = defineTool({
  name: 'link_transactions',
  description: 'Link unlinked transactions to an account by matching account_last4, bank, or account_name. Can look up the target account by ID or by name (lookupName).',
  schema: z.object({
    accountId: z.number().optional().describe('Account ID to link transactions to (if omitted, looks up by lookupName)'),
    lookupName: z.string().optional().describe('Account name to look up (used when accountId is unknown or wrong)'),
    accountLast4: z.string().optional().describe('Match transactions with this last4 digits'),
    bank: z.string().optional().describe('Match transactions from this bank'),
    accountName: z.string().optional().describe('Match transactions with this account_name'),
    dryRun: z.boolean().optional().describe('If true, report matches without modifying'),
  }),
  func: async ({ accountId, lookupName, accountLast4, bank, accountName, dryRun }) => {
    // Resolve account: try by ID first, then fall back to name lookup
    let account = accountId ? getAccountById(db, accountId) : undefined;
    if (!account && lookupName) {
      const all = getAccounts(db, { active: true });
      account = all.find((a) => a.name.toLowerCase() === lookupName.toLowerCase());
    }
    if (!account && accountName) {
      const all = getAccounts(db, { active: true });
      account = all.find((a) => a.name.toLowerCase() === accountName!.toLowerCase());
    }
    if (!account) {
      const hint = lookupName || accountName ? ` Try 'account_manage list' to see available accounts.` : '';
      return formatToolResult({ error: `Account not found.${hint}` });
    }
    accountId = account.id;
    // Use the canonical account name for transaction matching
    if (accountName) accountName = account.name;

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
