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

export interface NetWorthOptions {
  action: 'summary' | 'trend' | 'balance_sheet';
  months?: number;
}

export const NET_WORTH_TREND_FEATURE = 'Net worth trends';

/**
 * Net worth data for one action, read from the database passed in. Returns the
 * plain object the chat tool wraps in formatToolResult. The Pro-license gate on
 * `trend` is NOT applied here: each caller (chat tool, WebMCP read) applies it
 * before calling, because what an unlicensed caller sees differs per surface.
 */
export function computeNetWorth(database: Database, opts: NetWorthOptions): Record<string, unknown> {
  const { action, months } = opts;
  switch (action) {
    case 'summary': {
      const summary = getNetWorthSummary(database);
      if (summary.accounts.length === 0) {
        return { message: 'No accounts configured. Add accounts to track net worth.' };
      }
      return {
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
      };
    }

    case 'trend': {
      const trend = getNetWorthTrend(database, months ?? 12);
      if (trend.length === 0) {
        return { message: 'No balance snapshots found. Update account balances to build trend data.' };
      }
      return { months: trend.length, trend };
    }

    case 'balance_sheet': {
      const summary = getNetWorthSummary(database);
      if (summary.accounts.length === 0) {
        return { message: 'No accounts configured.' };
      }
      const equity = getEquitySummary(database);
      return {
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
      };
    }

    default:
      return { error: `Unknown action: ${action}` };
  }
}

export const netWorthTool = defineTool({
  name: 'net_worth',
  mutates: false, // audited read-only (#152, src/__tests__/mutation-audit.ts)
  description: 'Calculate net worth summary, trend over time, or full balance sheet.',
  schema: z.object({
    action: z.enum(['summary', 'trend', 'balance_sheet']).describe(
      'summary: current net worth breakdown. trend: monthly net worth change (Pro). balance_sheet: full account listing with equity.'
    ),
    months: z.number().optional().describe('Number of months for trend (default 12)'),
  }),
  func: async ({ action, months }) => {
    if (action === 'trend' && !hasLicense('pro')) return toolUpsell(NET_WORTH_TREND_FEATURE);
    return formatToolResult(computeNetWorth(db, { action, months }));
  },
});
