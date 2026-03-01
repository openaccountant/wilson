import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import { getPlaidItems } from '../../plaid/store.js';
import { getBalances } from '../../plaid/client.js';
import { hasLicense } from '../../licensing/license.js';

export const plaidBalancesTool = defineTool({
  name: 'plaid_balances',
  description: 'Show current account balances for all linked bank accounts via Plaid.',
  schema: z.object({}),
  func: async () => {
    if (!hasLicense('pro')) {
      return formatToolResult({
        error: 'Account balances is a Pro feature. Run `/license` for details or visit agentwilson.dev/pricing.',
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

    for (const item of items) {
      const balances = await getBalances(item.accessToken);
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

    return formatToolResult({
      balances: allBalances,
      message: `Retrieved balances for ${allBalances.reduce((n, i) => n + i.accounts.length, 0)} accounts across ${allBalances.length} institution(s).`,
    });
  },
});
