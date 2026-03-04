import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import { getPlaidItems } from '../../plaid/store.js';
import { getRecurringTransactions, hasLocalPlaidCreds } from '../../plaid/client.js';
import { hasLicense } from '../../licensing/license.js';
import { toolUpsell } from '../../licensing/upsell.js';

export const plaidRecurringTool = defineTool({
  name: 'plaid_recurring',
  description: 'Show recurring transactions (subscriptions, bills, income) for linked bank accounts via Plaid.',
  schema: z.object({}),
  func: async () => {
    if (!hasLicense('pro')) return toolUpsell('Recurring detection');

    const useProxy = !hasLocalPlaidCreds() && hasLicense('pro');
    if (!useProxy && !hasLocalPlaidCreds()) {
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

    const allStreams: Array<{
      institution: string;
      inflow: Array<{ description: string; merchant: string | null; amount: number; frequency: string; active: boolean }>;
      outflow: Array<{ description: string; merchant: string | null; amount: number; frequency: string; active: boolean }>;
    }> = [];

    for (const item of items) {
      const { inflow, outflow } = await getRecurringTransactions(item.accessToken, useProxy);
      allStreams.push({
        institution: item.institutionName,
        inflow: inflow.map((s) => ({
          description: s.description,
          merchant: s.merchantName,
          amount: s.amount,
          frequency: s.frequency,
          active: s.isActive,
        })),
        outflow: outflow.map((s) => ({
          description: s.description,
          merchant: s.merchantName,
          amount: s.amount,
          frequency: s.frequency,
          active: s.isActive,
        })),
      });
    }

    const totalInflow = allStreams.reduce((n, i) => n + i.inflow.length, 0);
    const totalOutflow = allStreams.reduce((n, i) => n + i.outflow.length, 0);

    return formatToolResult({
      recurring: allStreams,
      message: `Found ${totalOutflow} recurring outflows (subscriptions/bills) and ${totalInflow} recurring inflows across ${allStreams.length} institution(s).`,
    });
  },
});
