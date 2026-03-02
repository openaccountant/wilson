import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import type { Database } from '../../db/compat-sqlite.js';
import { upsertAccountFromPlaid } from '../../db/net-worth-queries.js';
import { getPlaidItems } from '../../plaid/store.js';
import { getBalances } from '../../plaid/client.js';
import { hasLicense } from '../../licensing/license.js';

let db: Database;

export function initPlaidBalancesTool(database: Database) {
  db = database;
}

export const plaidBalancesTool = defineTool({
  name: 'plaid_balances',
  description: 'Show current account balances for all linked bank accounts via Plaid. Also updates account records and balance snapshots.',
  schema: z.object({}),
  func: async () => {
    if (!hasLicense('pro')) {
      return formatToolResult({
        error: 'Account balances is a Pro feature. Run `/license` for details or visit openaccountant.ai/pricing.',
      });
    }

    if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
      return formatToolResult({
        message: 'Plaid not configured. Set PLAID_CLIENT_ID and PLAID_SECRET.',
      });
    }

    const items = getPlaidItems();
    if (items.length === 0) {
      return formatToolResult({
        message: 'No bank accounts linked. Use /connect to link a bank account.',
      });
    }

    const allBalances: Array<{
      institution: string;
      accounts: Array<{
        name: string;
        mask: string;
        type: string;
        current: number | null;
        available: number | null;
        currency: string | null;
      }>;
    }> = [];

    let accountsCreated = 0;
    let accountsUpdated = 0;

    for (const item of items) {
      const balances = await getBalances(item.accessToken);

      // Upsert accounts into the accounts table for net worth tracking
      if (db) {
        for (const b of balances) {
          if (b.balanceCurrent !== null) {
            const { created } = upsertAccountFromPlaid(db, {
              plaidAccountId: b.accountId,
              name: b.name,
              mask: b.mask,
              plaidType: b.type,
              plaidSubtype: b.subtype,
              balance: b.balanceCurrent,
              currency: b.isoCurrencyCode ?? 'USD',
              institution: item.institutionName,
            });
            if (created) accountsCreated++;
            else accountsUpdated++;
          }
        }
      }

      allBalances.push({
        institution: item.institutionName,
        accounts: balances.map((b) => ({
          name: b.name,
          mask: b.mask,
          type: `${b.type}/${b.subtype}`,
          current: b.balanceCurrent,
          available: b.balanceAvailable,
          currency: b.isoCurrencyCode,
        })),
      });
    }

    const totalAccounts = allBalances.reduce((n, i) => n + i.accounts.length, 0);
    let message = `Retrieved balances for ${totalAccounts} accounts across ${allBalances.length} institution(s).`;
    if (accountsCreated > 0) message += ` ${accountsCreated} new account(s) added.`;
    if (accountsUpdated > 0) message += ` ${accountsUpdated} balance(s) updated.`;

    return formatToolResult({
      balances: allBalances,
      accountsCreated,
      accountsUpdated,
      message,
    });
  },
});
