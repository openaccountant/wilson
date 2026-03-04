import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';
import type { Database } from '../../db/compat-sqlite.js';
import { hasLicense } from '../../licensing/license.js';
import { toolUpsell } from '../../licensing/upsell.js';
import {
  getNetWorthSummary,
  getNetWorthTrend,
  getEquitySummary,
} from '../../db/net-worth-queries.js';
import { SUBTYPE_LABELS, type AccountSubtype } from './account-types.js';

let db: Database;

export function initNetWorthTool(database: Database) {
  db = database;
}

export const netWorthTool = defineTool({
  name: 'net_worth',
  description: 'Calculate net worth summary, trend over time, or full balance sheet.',
  schema: z.object({
    action: z.enum(['summary', 'trend', 'balance_sheet']).describe(
      'summary: current net worth breakdown. trend: monthly net worth change (Pro). balance_sheet: full account listing with equity.'
    ),
    months: z.number().optional().describe('Number of months for trend (default 12)'),
  }),
  func: async ({ action, months }) => {
    switch (action) {
      case 'summary': {
        const summary = getNetWorthSummary(db);
        if (summary.accounts.length === 0) {
          return formatToolResult({ message: 'No accounts configured. Add accounts to track net worth.' });
        }
        return formatToolResult({
          netWorth: summary.netWorth,
          totalAssets: summary.totalAssets,
          totalLiabilities: summary.totalLiabilities,
          assets: summary.assetsBySubtype.map((a) => ({
            subtype: SUBTYPE_LABELS[a.subtype as AccountSubtype] ?? a.subtype,
            total: a.total,
            count: a.count,
          })),
          liabilities: summary.liabilitiesBySubtype.map((l) => ({
            subtype: SUBTYPE_LABELS[l.subtype as AccountSubtype] ?? l.subtype,
            total: l.total,
            count: l.count,
          })),
        });
      }

      case 'trend': {
        if (!hasLicense('pro')) return toolUpsell('Net worth trends');
        const trend = getNetWorthTrend(db, months ?? 12);
        if (trend.length === 0) {
          return formatToolResult({ message: 'No balance snapshots found. Update account balances to build trend data.' });
        }
        return formatToolResult({ months: trend.length, trend });
      }

      case 'balance_sheet': {
        const summary = getNetWorthSummary(db);
        if (summary.accounts.length === 0) {
          return formatToolResult({ message: 'No accounts configured.' });
        }
        const equity = getEquitySummary(db);
        return formatToolResult({
          netWorth: summary.netWorth,
          assets: summary.accounts
            .filter((a) => a.account_type === 'asset')
            .map((a) => ({
              id: a.id,
              name: a.name,
              subtype: SUBTYPE_LABELS[a.account_subtype as AccountSubtype] ?? a.account_subtype,
              balance: a.current_balance,
              institution: a.institution,
            })),
          liabilities: summary.accounts
            .filter((a) => a.account_type === 'liability')
            .map((a) => ({
              id: a.id,
              name: a.name,
              subtype: SUBTYPE_LABELS[a.account_subtype as AccountSubtype] ?? a.account_subtype,
              balance: a.current_balance,
              institution: a.institution,
            })),
          equity: equity.length > 0 ? equity : undefined,
          totalAssets: summary.totalAssets,
          totalLiabilities: summary.totalLiabilities,
        });
      }

      default:
        return formatToolResult({ error: `Unknown action: ${action}` });
    }
  },
});
